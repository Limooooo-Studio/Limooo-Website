/**
 * Limooo 人机验证门禁 — Cloudflare Pages Functions 中间件
 *
 * 流程：
 *   1. 每个请求先检查 __gate cookie（HMAC-SHA256 签名，payload 仅含过期时间戳）
 *   2. cookie 有效 → next() 放行；无效/缺失 → 302 到 verify.limooo.cn/__gate 出验证页
 *   3. 验证页 POST /__gate/verify → 服务端调 Turnstile siteverify →
 *      成功签发 cookie（Domain=.limooo.cn，跨子域；中国大陆 30 分钟有效，
 *      其它地区 5 分钟有效）并经 redirect.limooo.cn 回原主机原路径
 *      （仅允许站内相对路径，防开放重定向）
 * 合规爬虫（搜索引擎、社交预览、SEO 工具、监控、主流 AI 爬虫等）无法完成
 * Turnstile，若被门禁拦截会得到 403，导致 Search Console 报 "Blocked due to
 * access forbidden (403)"。因此在门禁判定前放行可信爬虫：Cloudflare 已验证的
 * bot，或 UA 命中下方合规爬虫名单（仅软性防御：能自证身份的合法爬虫放行）。
 *
 * 环境变量（在 Pages 项目设置里配成 Secret）：
 *   TURNSTILE_SITEKEY / TURNSTILE_SECRET / GATE_HMAC_KEY
 */

import { queryAll, execute } from "./_lib/d1";
import { logEvent } from "./_lib/logging";
import { requireAuth } from "./_lib/session";
import { SECURITY_HEADERS } from "./_lib/security";
import type { Env } from "./_lib/env";
import {
  GATE_COOKIE,
  GATE_HOST,
  LANG_COOKIE,
  PUBLIC_HOSTS,
  REDIRECT_HOST,
  REDIRECT_HOSTNAME,
  SUPPORTED_LANGS,
} from "./_lib/config";
import {
  GATE_I18N,
  REDIRECT_I18N,
  REDIRECT_PRELOAD_IMAGES,
} from "./_data/runtime";

interface EventContext {
  request: Request;
  env: Env;
  next(): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
}

type PagesFunction = (context: EventContext) => Promise<Response>;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 8000;

// 不能被门禁拦截的路径（否则死循环）
const SKIP_PATHS = new Set<string>([
  "/__gate/verify",
  "/__gate/diag",
  "/Limooo-xtext.webp",
  "/favicon.ico",
]);
// 门禁/封禁白名单（信任来源，如测试机/管理机）：直接放行，不依赖 CF 挑战与 Turnstile
const GATE_WHITELIST = new Set<string>(["97.64.18.11"]);
// /static/ 下的 CSS/字体等公开静态资源也放行：
// 主站页面本身已由门禁保护，但外部引用（如 authentik 登录页 logo 指向
// limooo.cn/static/...，作品图/二维码走 images.limooo.cn）不带 __gate
// cookie，被拦会 302 导致资源加载失败。

const textEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data)));
  return toHex(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** cookie 格式：<过期时间戳>.<HMAC-SHA256 hex 签名>，只放过期时间戳 */
async function isValidGateCookie(value: string | undefined, key: string): Promise<boolean> {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!/^\d{10,}$/.test(payload)) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;

  const expected = await hmacSha256Hex(key, payload);
  if (!timingSafeEqual(signature, expected)) return false;

  const expiry = Number(payload);
  return Number.isSafeInteger(expiry) && expiry > Math.floor(Date.now() / 1000);
}

function getCookie(name: string, header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** 只允许站内相对路径：以 / 开头、拒绝 //、反斜杠和任何协议前缀 */
function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "/";
  return raw.slice(0, 2048);
}

/** 把站内路径包装成经 redirect.limooo.cn 的跳转（host 已白名单校验） */
function viaRedirect(host: string, path: string): string {
  return `${REDIRECT_HOST}?to=${encodeURIComponent(`https://${host}${path}`)}`;
}

/** 门禁回跳目标主机只允许公开白名单，其余一律回主站 */
function sanitizeHost(raw: string | null | undefined): string {
  return raw && PUBLIC_HOSTS.has(raw) ? raw : "limooo.cn";
}

/** 签发 __gate cookie（与 /__gate/verify 同款：HMAC 签名 + 1 小时有效，Domain=.limooo.cn） */
async function mintGateCookie(key: string): Promise<string> {
  const ttlSeconds = 3600;
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmacSha256Hex(key, String(expiry));
  return `${GATE_COOKIE}=${expiry}.${signature}; Domain=.limooo.cn; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
}

/** 语言检测：cookie > Accept-Language(zh/en/ja/ko) > CF 地区(CN/JP/KR) > en-us */
function detectLang(request: Request): string {
  const cookie = getCookie(LANG_COOKIE, request.headers.get("Cookie"));
  // 兼容历史大写 cookie（zh-cn 等）
  if (cookie && SUPPORTED_LANGS.includes(cookie.toLowerCase())) return cookie.toLowerCase();

  const accept = request.headers.get("Accept-Language") ?? "";
  for (const part of accept.split(",")) {
    const p = part.trim().split(";")[0].toLowerCase();
    if (p.startsWith("zh")) return "zh-cn";
    if (p.startsWith("en")) return "en-us";
    if (p.startsWith("ja")) return "ja-jp";
    if (p.startsWith("ko")) return "ko-kr";
  }

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const byCountry: Record<string, string> = { CN: "zh-cn", JP: "ja-jp", KR: "ko-kr" };
  if (cf?.country && byCountry[cf.country]) return byCountry[cf.country];
  return "en-us";
}

/** 语言 cookie（与 Flask persist_detected_lang 一致，跨子域共享、365 天） */
function langCookieHeader(host: string, lang: string): string {
  const domain = host.endsWith("limooo.cn") ? "Domain=.limooo.cn; " : "";
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; ${domain}`;
}

/**
 * 首次访问（无语言 cookie）时把检测出的语言写回，此后各子域固定使用该语言。
 * 注意不能原地修改传入响应的 headers：Response.redirect() 等构造的响应头是
 * 不可变的，生产环境 append 会抛 TypeError（本地 miniflare 不报）。统一改为
 * 拷贝头 + 新建 Response，所有调用点（含重定向）都安全。
 */
/** 复制响应头时保留多条 Set-Cookie，避免 Safari 只认第一条导致 cookie 失效。 */
function preserveSetCookie(headers: Headers, source: Headers): void {
  const getSetCookie = (
    source as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(source) : [];
  if (!cookies.length) return;
  headers.delete("Set-Cookie");
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
}

function withLangCookie(request: Request, resp: Response): Response {
  if (getCookie(LANG_COOKIE, request.headers.get("Cookie"))) return resp;
  const headers = new Headers(resp.headers);
  preserveSetCookie(headers, resp.headers);
  headers.append("Set-Cookie", langCookieHeader(request.headers.get("Host") ?? "", detectLang(request)));
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/** 统一注入安全响应头；API 只加 nosniff，避免破坏 JSON 接口。 */
function withSecurityHeaders(request: Request, resp: Response): Response {
  const headers = new Headers(resp.headers);
  preserveSetCookie(headers, resp.headers);
  const isApi = new URL(request.url).pathname.startsWith("/api/");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (isApi && name !== "X-Content-Type-Options") continue;
    headers.set(name, value);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/** 主机+路径 → 应吐出的语言页面资产；静态资源等返回 null 走 next() */
function pageAsset(host: string, pathname: string, lang: string): string | null {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (host === "services.limooo.cn") {
    return p === "/" || p === "/index.html" || p === "/services"
      ? `/${lang}/services.html`
      : null;
  }
  if (host === "contact.limooo.cn") {
    return p === "/" || p === "/index.html" || p === "/contact"
      ? `/${lang}/contact.html`
      : null;
  }
  if (host === "visitor.limooo.cn") {
    return p === "/" || p === "/index.html" || p === "/visitor"
      ? `/${lang}/visitor.html`
      : null;
  }
  if (host === "appleid.limooo.cn") {
    return p === "/" || p === "/index.html" || p === "/appleid"
      ? `/${lang}/appleid.html`
      : null;
  }
  if (host === "limooo.cn" || host === "www.limooo.cn") {
    if (p === "/" || p === "/index.html") return `/${lang}/index.html`;
    if (p === "/services") return `/${lang}/services.html`;
    if (p === "/contact") return `/${lang}/contact.html`;
  }
  return null;
}

/** 封禁检查：精确 IP 或 /24 网段（与 Flask 端行为一致；DB 异常时放行） */
async function isBlocked(env: Env, request: Request, ip: string): Promise<boolean> {
  if (!env.DB || !ip) return false;
  const url = new URL(request.url);
  try {
    const exact = await queryAll<{ cidr: string }>(
      env.DB,
      "SELECT cidr FROM blocked_ips WHERE cidr = ?",
      ip,
    );
    if (exact.length) {
      await logEvent(env, "block_match", request, {
        ip,
        path: url.pathname,
        outcome: "blocked",
        status: 403,
        message: `cidr=${exact[0].cidr}`,
      });
      return true;
    }
    if (ip.split(".").length === 4) {
      const prefix = ip.split(".").slice(0, 3).join(".");
      const subnet = await queryAll<{ cidr: string }>(
        env.DB,
        "SELECT cidr FROM blocked_ips WHERE cidr = ?",
        `${prefix}.0/24`,
      );
      if (subnet.length) {
        await logEvent(env, "block_match", request, {
          ip,
          path: url.pathname,
          outcome: "blocked",
          status: 403,
          message: `cidr=${subnet[0].cidr}`,
        });
        return true;
      }
    }
  } catch {
    // fail-open：DB 不可用时不做应用层拦截
  }
  return false;
}

/**
 * 合规爬虫 UA 名单（仅软性防御：能自证身份的合法爬虫直接放行，不经过人机门禁）。
 * 覆盖：搜索引擎、社交平台预览、SEO/站点分析工具、监控类、主流 AI 爬虫。
 */
const CRAWLER_UA_RE = new RegExp(
  [
    // 搜索引擎 / 搜索预览
    "Googlebot", "Google-InspectionTool", "GoogleOther", "Google-Site-Verification",
    "Google-Extended", "Storebot-Google", "FeedFetcher-Google", "Mediapartners-Google",
    "APIs-Google", "AdsBot", "Bingbot", "BingPreview", "Baiduspider", "Sogou",
    "YisouSpider", "360Spider", "YandexBot", "YandexImages", "YandexMobileBot",
    "DuckDuckBot", "Slurp", "Bytespider", "PetalBot", "Applebot", "Applebot-Extended",
    "SeznamBot", "Qwantify", "MojeekBot", "YepBot", "NaverBot", "Yeti", "Exabot",
    "ia_archiver", "archive.org_bot", "Startpagina-Bot", "Mail.RU_Bot",
    // 社交平台预览
    "facebookexternalhit", "facebookcatalog", "Twitterbot", "LinkedInBot", "Pinterest",
    "redditbot", "Slackbot", "Discordbot", "TelegramBot", "WhatsApp", "SkypeUriPreview",
    "Viber", "Tumblr", "Google-Structured-Data-Testing-Tool",
    // SEO / 站点分析工具
    "SemrushBot", "AhrefsBot", "MJ12bot", "DotBot", "rogerbot", "Screaming Frog",
    "DataForSeoBot", "SerpstatBot", "SEOkicks", "MegaIndex", "SiteAuditBot", "Siteliner",
    "W3C_Validator", "Validator.nu", "Chrome-Lighthouse",
    // 主流 AI 爬虫（均自报 UA 并遵守 robots.txt）
    "GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "anthropic-ai", "Claude-Web",
    "PerplexityBot", "Amazonbot", "cohere-ai", "CCBot", "Diffbot", "ImagesiftBot",
    "YouBot", "meta-externalagent", "Meta-ExternalFetcher",
    // 监控 / 健康检查
    "UptimeRobot", "Pingdom", "GTmetrix", "StatusCake", "Site24x7", "Datadog",
    "New Relic", "Zabbix",
  ].join("|"),
  "i",
);

/** 可信爬虫判定：Cloudflare Bot Management 验证通过，或 UA 命中已知爬虫名单 */
function isTrustedCrawler(request: Request): boolean {
  const cf = (request as Request & { cf?: { botManagement?: { verifiedBot?: boolean } } }).cf;
  if (cf?.botManagement?.verifiedBot === true) return true;
  return CRAWLER_UA_RE.test(request.headers.get("User-Agent") ?? "");
}

/** 页面 GET 且非噪音类目：才做访客埋点（静态资源 / API / 门禁路径 / 跳转子域不记） */
function shouldTrackVisit(request: Request, url: URL): boolean {
  if (request.method !== "GET") return false;
  // 爬虫不算访客，不埋点（避免 Googlebot 等刷高 visitor 统计）
  if (isTrustedCrawler(request)) return false;
  if (url.hostname === "images.limooo.cn") return false; // 图片子域全量不埋点
  const p = url.pathname;
  if (
    p.startsWith("/api/") ||
    p.startsWith("/static/") ||
    p.startsWith("/__gate") ||
    p.startsWith("/favicon") ||
    p === "/Limooo-xtext.webp"
  ) {
    return false;
  }
  if (/\.(png|webp|jpg|jpeg|gif|ico|svg|css|js|json|webmanifest|txt|xml)$/i.test(p)) {
    return false;
  }
  if (url.hostname === REDIRECT_HOSTNAME) return false;
  return true;
}

/** 访客前向统计：响应发出后记录（含状态码；不记录访问路径） */
async function recordVisit(env: Env, request: Request, status: number): Promise<void> {
  if (!env.DB) return;
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  try {
    await execute(
      env.DB,
      "INSERT INTO visitors (ip, country, path, status) VALUES (?, ?, '', ?)",
      ip,
      cf?.country ?? "",
      status,
    );
  } catch (error) {
    // 埋点失败不阻塞请求
    await logEvent(env, "visit_record_error", request, {
      outcome: "failed",
      message: String(error),
    });
  }
}

/** 记录每次请求的 Ray ID 与请求信息（供按 Ray ID 反查；DB 异常时放行） */
async function recordRay(env: Env, request: Request, status: number): Promise<void> {
  if (!env.DB) return;
  const url = new URL(request.url);
  // 查询接口自身的请求不记录，避免自查询递归
  if (url.pathname.startsWith("/api/ray/")) return;
  const ray = request.headers.get("CF-Ray") ?? "";
  if (!ray) return;
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  try {
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO ray_log (ray, ts, host, path, method, status, ip, country, ua)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?)`,
      ray,
      url.hostname,
      url.pathname + url.search,
      request.method,
      status,
      request.headers.get("CF-Connecting-IP") ?? "",
      cf?.country ?? "",
      (request.headers.get("User-Agent") ?? "").slice(0, 300),
    );
  } catch (error) {
    // fail-open：记录失败不阻塞请求
    await logEvent(env, "ray_record_error", request, {
      outcome: "failed",
      message: String(error),
    });
  }
}

/** 调 Turnstile siteverify，带超时；网络/HTTP 错误向上抛，由调用方给明确报错页 */
async function verifyTurnstile(token: string, remoteip: string, secret: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const resp = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip }).toString(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`siteverify HTTP ${resp.status}`);
    const data = (await resp.json()) as { success?: boolean };
    return data.success === true;
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

interface GateRenderOptions {
  next?: string;
  host?: string;
  errorKey?: string;
  unavailable?: boolean;
}

function renderGatePage(context: EventContext, opts: GateRenderOptions): Response {
  const { request, env } = context;
  const url = new URL(request.url);
  const host = sanitizeHost(opts.host);
  const next = safeNextPath(opts.next ?? "/");
  const lang = detectLang(request);
  const t = (key: string): string => GATE_I18N[lang]?.[key] ?? GATE_I18N["en-us"][key] ?? key;

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const country = cf?.country ?? "—";
  const ip = request.headers.get("CF-Connecting-IP") || "—";
  const ray = request.headers.get("CF-Ray") || "—";
  const sitekey = env.TURNSTILE_SITEKEY ?? "";
  const status = opts.unavailable ? 503 : 403;

  const errorHtml = opts.errorKey
    ? `<div class="error" data-i18n="error_${opts.errorKey}">${t(`error_${opts.errorKey}`)}</div>`
    : "";
  const turnstileHtml = sitekey
    ? `<div id="turnstile-wrap"></div>`
    : `<div class="error" data-i18n="error_sitekey">${t("error_sitekey")}</div>`;
  const turnstileSrc = sitekey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>`
    : "";
  // 除动态诊断信息（Location/IP/Ray ID，由 /__gate/diag 实时获取）外，页面可缓存：
  // 已有语言 cookie 的请求可边缘缓存；首次访问需写语言 cookie，退化为浏览器私有缓存
  const hasLangCookie = Boolean(getCookie(LANG_COOKIE, request.headers.get("Cookie")));
  const cacheControl =
    opts.errorKey || !sitekey ? "no-store" : hasLangCookie ? "public, max-age=300" : "private, max-age=300";

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark light">
<!-- ── 图标（与主站 base.html 一致） ── -->
<link rel="icon" href="https://images.limooo.cn/icons/favicon.ico" sizes="any">
<link rel="icon" href="https://images.limooo.cn/icons/favicon.png" type="image/png" sizes="256x256">
<link rel="apple-touch-icon" href="https://images.limooo.cn/icons/favicon.png">
<title>${t("title")}</title>
<script>
  // 与主站共用 localStorage key "theme"：首次跟随系统，点击后固定并缓存
  (function () {
    var t = localStorage.getItem('theme');
    if (t === 'light' || (!t && window.matchMedia('(prefers-color-scheme: light)').matches)) {
      document.documentElement.classList.add('light-mode');
    }
  })();
</script>
<style>
  /* Inter 自托管变量字体（与 static/fonts.css 同源，门禁页独立内联：
     字体从本站 Pages 的 /static/fonts/ 出，不依赖主站；许可见 /static/fonts/inter/LICENSE.txt） */
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-cyrillic-ext-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-cyrillic-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-greek-ext-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+1F00-1FFF; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-greek-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-vietnamese-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-latin-ext-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-latin-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  /* Baloo 2 品牌字体（页脚 LIMOOO 商标，许可见 /static/fonts/baloo2/OFL.txt） */
  @font-face { font-family:'Baloo 2'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/baloo2/baloo2-latin-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    color-scheme: dark;
    --bg-a: #17181c; --bg-b: #101114;
    --text: #e2e2e3; --muted: #9ca3af;
    --line: #2e2e32; --panel: #202127; --highlight: #2a2a2f;
    --accent: #05A5A6;
    --foot: #E7EBCE;
    /* 主站同款控件变量 */
    --bg: #1b1b1f; --panel-bg: #202127;
    --radius-sm: 6px; --radius-md: 10px;
    --switch-icon: #dfdfd6; --switch-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    --footer-border: #2e2e32;
    --ls-scale: 0.65;
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  }
  html[lang^="en"] { --ls-scale: 0.3; }
  .light-mode {
    color-scheme: light;
    --bg-a: #f3f4f6; --bg-b: #e5e7eb;
    --text: #1f2328; --muted: #6b7280;
    --line: #e2e2e3; --panel: #ffffff; --highlight: #f2f2f3;
    --foot: #9ca3af;
    --bg: #ffffff; --panel-bg: #f6f6f7;
    --switch-icon: #67676c; --switch-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
    --footer-border: #e2e2e3;
  }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex; align-items: center; justify-content: center;
    min-height: 100dvh;
    min-height: 100vh;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
    transition: background 300ms var(--ease-out);
  }
  /* 右上角控件组（语言切换 + 深浅切换，样式与主站导航栏一致） */
  .gate-controls {
    position: fixed; top: 18px; right: 18px; z-index: 10;
    display: flex; align-items: center; gap: 8px;
  }
  /* 语言/深浅切换之间的竖线分隔符（与主站导航栏一致） */
  .nav-divider {
    width: 1px; height: 24px;
    background: var(--line);
    margin: 0 12px;
    flex-shrink: 0;
  }
  @media (max-width: 767px) { .nav-divider { display: none; } }
  /* ── 语言切换按钮（与主站一致：文A 图标 + 下箭头） ── */
  .theme-toggle { position: relative; display: flex; align-items: center; }
  .lang-btn {
    display: flex; align-items: center;
    padding: 0 12px; height: 36px;
    border: none; background: none; cursor: pointer;
    color: var(--text);
    transition: color 200ms var(--ease-out);
  }
  @media (hover: hover) and (pointer: fine) {
    .lang-btn:hover { color: var(--accent); }
  }
  .lang-btn .lang-icon { width: 16px; height: 16px; }
  .lang-btn .lang-chevron { width: 14px; height: 14px; margin-left: 4px; opacity: 0.6; }
  /* ── 语言菜单（与主站一致：VitePress VPFlyout 弹出层） ── */
  .theme-menu {
    position: absolute; top: calc(100% + 8px); right: 0; min-width: 120px;
    background: var(--panel-bg); border: 1px solid var(--line); border-radius: var(--radius-md);
    padding: 4px; z-index: 200;
    opacity: 0; visibility: hidden;
    transform: translateY(-4px) scale(0.92);
    transform-origin: top right;
    transition: opacity 150ms var(--ease-out), transform 150ms var(--ease-out), visibility 150ms;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.15);
  }
  .theme-menu.open {
    opacity: 1; visibility: visible; transform: translateY(0) scale(1);
    transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out);
  }
  .theme-option {
    padding: 8px 14px; margin: 2px 0; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600;
    letter-spacing: calc(0.05em * var(--ls-scale)); cursor: pointer; white-space: nowrap;
    transition: background 150ms var(--ease-out);
    opacity: 0.5;
  }
  .lang-flag { margin-right: 6px; }
  .theme-option.selected {
    opacity: 1; background: var(--highlight);
  }
  @media (hover: hover) and (pointer: fine) {
    .theme-option:hover { opacity: 1; background: var(--highlight); }
  }
  /* ── 深浅切换（与主站一致：太阳-月亮胶囊滑块） ── */
  .appearance-switch {
    position: relative; border-radius: 11px; display: block;
    width: 40px; height: 22px; flex-shrink: 0;
    border: 1px solid var(--line);
    background: var(--highlight);
    cursor: pointer; padding: 0;
    transition: border-color 200ms var(--ease-out), background-color 200ms var(--ease-out);
  }
  @media (hover: hover) and (pointer: fine) {
    .appearance-switch:hover { border-color: var(--accent); }
  }
  .appearance-check {
    position: absolute; top: 1px; left: 1px;
    width: 18px; height: 18px; border-radius: 50%;
    background: var(--bg);
    box-shadow: var(--switch-shadow);
    transform: translateX(18px); /* 默认深色：滑块在右 */
    transition: transform 250ms var(--ease-out);
  }
  .appearance-icon {
    position: relative; display: block; width: 18px; height: 18px;
    border-radius: 50%; overflow: hidden;
  }
  .appearance-icon svg {
    position: absolute; top: 3px; left: 3px; width: 12px; height: 12px;
    color: var(--switch-icon);
    transition: opacity 250ms var(--ease-out);
  }
  /* 默认（深色）：月亮可见；浅色：太阳可见 */
  .appearance-icon .sun { opacity: 0; }
  .appearance-icon .moon { opacity: 1; }
  .light-mode .appearance-icon .sun { opacity: 1; }
  .light-mode .appearance-icon .moon { opacity: 0; }
  .light-mode .appearance-check { transform: translateX(0); }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
    max-width: 640px;
    width: 100%;
    padding: 40px 40px 28px;
    transition: background 300ms var(--ease-out), border-color 300ms var(--ease-out);
  }
  .logo { display: block; margin: 0 auto 22px; max-width: 220px; height: auto; }
  h1 {
    font-size: 18px; font-weight: 600; text-align: center;
    color: var(--text); line-height: 1.5; margin-bottom: 24px;
  }
  .turnstile-wrap { display: flex; justify-content: center; min-height: 65px; margin-bottom: 26px; }
  .error {
    background: rgba(185, 28, 28, 0.12); border: 1px solid rgba(185, 28, 28, 0.4);
    color: var(--text);
    border-radius: 6px; padding: 10px 14px; font-size: 14px;
    margin-bottom: 18px; text-align: center;
  }
  .divider { border: none; border-top: 1px solid var(--line); margin: 0 0 16px; }
  .diag {
    display: grid; grid-template-columns: 96px 1fr; gap: 5px 14px;
    font-size: 13px; color: var(--text); margin-bottom: 20px;
  }
  .diag dt { color: var(--muted); text-align: right; }
  .diag dd { overflow-wrap: anywhere; }
  .foot { text-align: center; font-size: 12px; color: var(--foot); }
  /* ── 底部版权（与主站 base.html 一致） ── */
  .global-footer {
    position: fixed; bottom: 0; left: 0; width: 100%; z-index: 90;
    border-top: 1px solid var(--footer-border);
    background-color: var(--bg) !important;
    display: flex; align-items: center; justify-content: center;
  }
  .footer-link {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%;
    padding: 1.25rem 0;
    padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
    color: inherit; text-decoration: none;
  }
  .footer-text {
    font-size: 10px; font-weight: 600;
    font-size-adjust: 0.546;
    letter-spacing: calc(0.15em*var(--ls-scale)); opacity: 0.5; text-align: center; line-height: 1;
  }
  .footer-brand {
    font-family: 'Baloo 2', ui-rounded, system-ui, sans-serif;
    font-weight: 700; letter-spacing: 0.02em;
  }
  @media (hover: none) and (pointer: coarse) {
    .global-footer { display: none !important; }
  }
</style>
</head>
<body>
<div class="gate-controls">
  <div class="theme-toggle lang-flyout">
    <button class="lang-btn" onclick="toggleLangMenu(event)" aria-haspopup="true" aria-label="${t("lang_aria")}" data-i18n-attr="aria-label:lang_aria">
      <svg class="lang-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>
      <svg class="lang-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div id="langMenu" class="theme-menu">
      <div class="theme-option${lang === "zh-cn" ? " selected" : ""}" data-lang="zh-cn" onclick="setLang('zh-cn')"><span class="lang-flag">🇨🇳</span><span>简体中文</span></div>
      <div class="theme-option${lang === "en-us" ? " selected" : ""}" data-lang="en-us" onclick="setLang('en-us')"><span class="lang-flag">🇺🇸</span><span>English</span></div>
      <div class="theme-option${lang === "ja-jp" ? " selected" : ""}" data-lang="ja-jp" onclick="setLang('ja-jp')"><span class="lang-flag">🇯🇵</span><span>日本語</span></div>
      <div class="theme-option${lang === "ko-kr" ? " selected" : ""}" data-lang="ko-kr" onclick="setLang('ko-kr')"><span class="lang-flag">🇰🇷</span><span>한국어</span></div>
    </div>
  </div>
  <span class="nav-divider hidden md:block"></span>
  <button class="appearance-switch" type="button" role="switch" aria-checked="false" aria-label="${t("theme_aria")}" data-i18n-attr="aria-label:theme_aria" onclick="toggleTheme()">
    <span class="appearance-check">
      <span class="appearance-icon">
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      </span>
    </span>
  </button>
</div>
<main class="card">
  <img class="logo" src="https://image.limooo.cn/icons/Limooo-xtext.webp" alt="LIMOOO" width="220">
  <h1 data-i18n="heading">${t("heading")}</h1>
  ${errorHtml}
  <form id="gate" method="post" action="/__gate/verify">
    <input type="hidden" name="host" value="${escapeHtml(host)}">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <div class="turnstile-wrap">${turnstileHtml}</div>
  </form>
  <hr class="divider">
  <dl class="diag">
    <dt data-i18n="location">${t("location")}</dt><dd id="diag-country">—</dd>
    <dt data-i18n="ip">${t("ip")}</dt><dd id="diag-ip">—</dd>
    <dt data-i18n="ray">${t("ray")}</dt><dd id="diag-ray">—</dd>
  </dl>
  <p class="foot" data-i18n-html="foot">${t("foot")}</p>
</main>
<footer class="global-footer" id="global-footer">
  <div class="footer-link">
    <div class="footer-text">&copy; 2026 <span class="footer-brand">LIMOOO</span> Studio<span data-i18n="footer_rights" data-i18n-prefix=" | ">${t("footer_rights") ? " | " + t("footer_rights") : ""}</span><span data-i18n="footer_source" data-i18n-prefix=" | ">${t("footer_source") ? " | " + t("footer_source") : ""}</span></div>
  </div>
</footer>
${turnstileSrc}
<script>
  var turnstileWidget = null;
  var TURNSTILE_SITEKEY = ${JSON.stringify(sitekey)};
  var CURRENT_LANG = ${JSON.stringify(lang)};
  var GATE_I18N = ${JSON.stringify(GATE_I18N)};

  function t(key) {
    var dict = GATE_I18N[CURRENT_LANG] || GATE_I18N["en-us"];
    return dict && dict[key] !== undefined ? dict[key] : key;
  }
  /* Turnstile 的 language 参数要求小写格式（zh-cn / en-us / ja / ko），
     直接传 zh-cn 等大写值不会被识别，widget 会回退到浏览器语言 */
  function turnstileLang(code) {
    return { "zh-cn": "zh-cn", "en-us": "en-us", "ja-jp": "ja", "ko-kr": "ko" }[code] || "auto";
  }

  function onTurnstileSuccess() {
    document.getElementById("gate").submit();
  }

  /* ── 主题切换（与主站一致：localStorage "theme"，首次跟随系统） ── */
  function getSystemTheme() {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function effectiveTheme() {
    var saved = localStorage.getItem("theme");
    return (saved === "light" || saved === "dark") ? saved : getSystemTheme();
  }
  function applyTheme(theme) {
    document.documentElement.classList.toggle("light-mode", theme === "light");
    var sw = document.querySelector(".appearance-switch");
    if (sw) sw.setAttribute("aria-checked", theme === "dark" ? "true" : "false");
  }
  function resetTurnstile() {
    var wrap = document.getElementById("turnstile-wrap");
    if (!wrap || !window.turnstile) return;
    // turnstile.reset() 不接受配置项，语言/主题只能在 render 时生效，
    // 因此切换语言或主题时必须先移除旧 widget，再用新配置重新渲染。
    if (turnstileWidget) {
      window.turnstile.remove(turnstileWidget);
      turnstileWidget = null;
    }
    turnstileWidget = window.turnstile.render(wrap, {
      sitekey: TURNSTILE_SITEKEY,
      callback: onTurnstileSuccess,
      theme: effectiveTheme() === "light" ? "light" : "dark",
      language: turnstileLang(CURRENT_LANG)
    });
  }
  function toggleTheme() {
    var next = effectiveTheme() === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    applyTheme(next);
    resetTurnstile();
  }

  /* ── 语言切换（与主站一致：cookie + 纯前端切换，不刷新页面） ── */
  function saveLangCookie(code) {
    var domain = location.hostname.endsWith("limooo.cn") ? "domain=.limooo.cn; " : "";
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = "user_lang_preference=" + code + "; path=/; max-age=31536000; SameSite=Lax" + secure + "; " + domain;
  }
  function renderI18n() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var text = t(el.getAttribute("data-i18n"));
      var prefix = el.getAttribute("data-i18n-prefix");
      if (prefix != null) text = text ? prefix + text : "";
      el.textContent = text;
    });
    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      el.getAttribute("data-i18n-attr").split("|").forEach(function (seg) {
        var colon = seg.indexOf(":");
        if (colon === -1) return;
        seg.slice(0, colon).split(",").forEach(function (attr) {
          el.setAttribute(attr.trim(), t(seg.slice(colon + 1)));
        });
      });
    });
  }
  function applyLang(lang) {
    if (!GATE_I18N[lang]) return;
    if (lang !== CURRENT_LANG) {
      CURRENT_LANG = lang;
      document.documentElement.lang = lang;
      renderI18n();
      document.querySelectorAll("#langMenu .theme-option").forEach(function (opt) {
        opt.classList.toggle("selected", opt.dataset.lang === lang);
      });
    }
    saveLangCookie(lang);
    resetTurnstile();
  }
  function toggleLangMenu(e) {
    if (e) e.stopPropagation();
    var m = document.getElementById("langMenu");
    if (m) m.classList.toggle("open");
  }
  function closeLangMenu() {
    var m = document.getElementById("langMenu");
    if (m) m.classList.remove("open");
  }
  function setLang(code) {
    closeLangMenu();
    applyLang(code);
  }
  /* 桌面端：语言菜单悬停自动展开/收起（与主站一致），触摸端保持点击切换 */
  (function bindLangHover() {
    var fly = document.querySelector(".lang-flyout");
    if (!fly) return;
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      fly.addEventListener("mouseenter", function () {
        var m = document.getElementById("langMenu");
        if (m) m.classList.add("open");
      });
      fly.addEventListener("mouseleave", closeLangMenu);
    }
  })();
  /* 点击控件外部时收起语言菜单 */
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".theme-toggle")) closeLangMenu();
  });
  function onloadTurnstileCallback() {
    resetTurnstile();
  }
  // 初始同步主题与文案（Turnstile 由 onloadTurnstileCallback 显式渲染）
  applyTheme(effectiveTheme());
  renderI18n();
  // 动态诊断信息（Location/IP/Ray ID）每次实时获取，页面其余部分走缓存
  fetch("/__gate/diag", { headers: { "Accept": "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var map = { "diag-country": d.country, "diag-ip": d.ip, "diag-ray": d.ray };
      Object.keys(map).forEach(function (id) {
        var el = document.getElementById(id);
        if (el && map[id]) el.textContent = map[id];
      });
    })
    .catch(function () {});
  /* 系统主题变化时：仅在无缓存（跟随系统）状态下自动跟随 */
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
    if (!localStorage.getItem("theme")) applyTheme(getSystemTheme());
  });
</script>
</body>
</html>`;

  return withLangCookie(request, new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cacheControl,
      // 语言由 cookie 决定：缓存必须按 cookie 区分，否则切换语言后刷新会命中旧语言缓存
      "Vary": "Cookie",
    },
  }));
}

/** 统一跳转页（redirect.limooo.cn）：纯中转，不经过人机验证 */
function renderRedirectPage(context: EventContext): Response {
  const { request } = context;
  const url = new URL(request.url);
  let to = url.searchParams.get("to") ?? "";
  // 与 Flask _safe_next 一致：只放行 https://（含站外），否则回主站
  if (!/^https:\/\//.test(to)) to = "https://limooo.cn/";
  const lang = detectLang(request);
  const t = REDIRECT_I18N[lang] ?? REDIRECT_I18N["en-us"];
  const preload = to.startsWith("https://limooo.cn/");
  const rels = preload ? REDIRECT_PRELOAD_IMAGES : [];
  const preloadLinks = rels.map((r) => `<link rel="preload" as="image" href="${r}">`).join("\n    ");

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- ── 图标（与主站 base.html 一致） ── -->
<link rel="icon" href="https://images.limooo.cn/icons/favicon.ico" sizes="any">
<link rel="icon" href="https://images.limooo.cn/icons/favicon.png" type="image/png" sizes="256x256">
<link rel="apple-touch-icon" href="https://images.limooo.cn/icons/favicon.png">
<title>${t.title}</title>
    ${preloadLinks}
<style>
  /* Inter 自托管变量字体（与 static/fonts.css 同源，门禁/跳转页独立内联：
     字体从本站 Pages 的 /static/fonts/ 出，不依赖主站；许可见 /static/fonts/inter/LICENSE.txt） */
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-cyrillic-ext-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-cyrillic-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-greek-ext-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+1F00-1FFF; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-greek-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-vietnamese-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-latin-ext-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
  @font-face { font-family:'Inter'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/inter/inter-latin-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  /* Baloo 2 品牌字体（页脚 LIMOOO 商标，许可见 /static/fonts/baloo2/OFL.txt） */
  @font-face { font-family:'Baloo 2'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/static/fonts/baloo2/baloo2-latin-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  :root {
    --bg: #1b1b1f;
    --footer-border: #2e2e32;
    --ls-scale: 0.65;
  }
  html[lang^="en"] { --ls-scale: 0.3; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #1b1b1f; color: #e5e9ef;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    font-weight: 500;
    -webkit-font-smoothing: antialiased;
  }
  .card { text-align: center; }
  .spinner {
    width: 22px; height: 22px; margin: 0 auto 14px;
    border: 2px solid rgba(255,255,255,0.15);
    border-top-color: #05A5A6;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .text { opacity: 0.55; letter-spacing: 0.04em; }
  /* ── 底部版权（与主站 base.html 一致） ── */
  .global-footer {
    position: fixed; bottom: 0; left: 0; width: 100%; z-index: 90;
    border-top: 1px solid var(--footer-border);
    background-color: var(--bg) !important;
    display: flex; align-items: center; justify-content: center;
  }
  .footer-link {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%;
    padding: 1.25rem 0;
    padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
    color: inherit; text-decoration: none;
  }
  .footer-text {
    font-size: 10px; font-weight: 600;
    font-size-adjust: 0.546;
    letter-spacing: calc(0.15em*var(--ls-scale)); opacity: 0.5; text-align: center; line-height: 1;
  }
  .footer-brand {
    font-family: 'Baloo 2', ui-rounded, system-ui, sans-serif;
    font-weight: 700; letter-spacing: 0.02em;
  }
  @media (hover: none) and (pointer: coarse) {
    .global-footer { display: none !important; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <div class="text">${t.text}</div>
    <noscript><a class="manual-link" href="${escapeHtml(to)}">${t.text}</a></noscript>
  </div>
  <footer class="global-footer" id="global-footer">
    <div class="footer-link">
      <div class="footer-text">&copy; 2026 <span class="footer-brand">LIMOOO</span> Studio<span data-i18n="footer_rights" data-i18n-prefix=" | ">${t.footer_rights ? " | " + t.footer_rights : ""}</span><span data-i18n="footer_source" data-i18n-prefix=" | ">${t.footer_source ? " | " + t.footer_source : ""}</span></div>
    </div>
  </footer>
  <script>
    (function () {
      var target = ${JSON.stringify(to)};
      var rels = ${JSON.stringify(rels)};
      function go() { location.replace(target); }
      if (rels.length === 0) { go(); return; }
      var pending = rels.length;
      var fired = false;
      function finish() {
        if (fired) return;
        fired = true;
        go();
      }
      rels.forEach(function (rel) {
        var img = new Image();
        img.onload = img.onerror = function () {
          pending -= 1;
          if (pending <= 0) finish();
        };
        img.src = rel;
      });
      setTimeout(finish, 800);
    })();
  </script>
</body>
</html>`;

  return withLangCookie(request, new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  }));
}

/** POST /__gate/verify：校验 Turnstile，成功签发 cookie 并 302 回原路径 */
async function handleVerify(context: EventContext): Promise<Response> {
  const { request, env } = context;
  const startedAt = Date.now();
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    await logEvent(env, "gate_verify", request, {
      outcome: "failed",
      status: 400,
      durationMs: Date.now() - startedAt,
      message: "invalid_form",
    });
    return renderGatePage(context, { errorKey: "invalid" });
  }

  const token = form.get("cf-turnstile-response")?.toString() ?? "";
  const next = safeNextPath(form.get("next")?.toString() ?? null);
  const host = sanitizeHost(form.get("host")?.toString() ?? null);
  const remoteip = request.headers.get("CF-Connecting-IP") ?? "";

  let success = false;
  let unavailable = false;
  if (!env.TURNSTILE_SECRET) {
    unavailable = true;
  } else {
    try {
      success = token !== "" && (await verifyTurnstile(token, remoteip, env.TURNSTILE_SECRET));
    } catch {
      unavailable = true;
    }
  }

  if (!success) {
    await logEvent(env, "gate_verify", request, {
      outcome: unavailable ? "unavailable" : "failed",
      status: unavailable ? 503 : 403,
      durationMs: Date.now() - startedAt,
      message: unavailable
        ? env.TURNSTILE_SECRET
          ? "turnstile_unavailable"
          : "turnstile_secret_missing"
        : token
          ? "turnstile_rejected"
          : "missing_token",
    });
    return renderGatePage(context, {
      host,
      next,
      unavailable,
      errorKey: unavailable ? "unavailable" : "failed",
    });
  }

  // 所有地区用户单次认证有效 1 小时（3600 秒）
  const ttlSeconds = 3600;
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmacSha256Hex(env.GATE_HMAC_KEY, String(expiry));
  // Domain=.limooo.cn：验证页在 auth.limooo.cn 签发，主站子域都能识别
  const cookie =
    `${GATE_COOKIE}=${expiry}.${signature}; Domain=.limooo.cn; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;

  await logEvent(env, "gate_verify", request, {
    outcome: "success",
    status: 302,
    durationMs: Date.now() - startedAt,
    message: "cookie_issued",
  });

  // 验证成功只签发 __gate cookie：若再叠加语言 cookie，Workers 会把两条
  // Set-Cookie 合并，Safari 只认第一条，导致 __gate 落盘失败、回跳后再次被拦。
  return new Response(null, {
    status: 302,
    headers: {
      Location: viaRedirect(host, next),
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  });
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const resp = withSecurityHeaders(request, await handleOnRequest(context));
  // 响应发出后再埋点（拿真实状态码），未验证 / 封禁 / 正常页面都记
  if (shouldTrackVisit(request, url)) {
    if (typeof context.waitUntil === "function") {
      context.waitUntil(recordVisit(env, request, resp.status));
    } else {
      void recordVisit(env, request, resp.status);
    }
  }
  // 所有请求（含 API / 静态 / 门禁）都记 Ray ID，供 check-ray-id 按 ID 反查
  if (typeof context.waitUntil === "function") {
    context.waitUntil(recordRay(env, request, resp.status));
  } else {
    void recordRay(env, request, resp.status);
  }
  return resp;
};

async function handleOnRequest(context: EventContext): Promise<Response> {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 跳转子域：纯中转页，豁免人机验证（否则验证通过后经它回跳会再被拦，死循环）
  if (url.hostname === REDIRECT_HOSTNAME) {
    return renderRedirectPage(context);
  }

  // /__gate/verify 与静态放行路径不能被门禁拦（否则死循环）
  if (url.pathname === "/__gate/verify") {
    return handleVerify(context);
  }
  // 动态诊断信息 API：每次实时返回，不缓存（页面其余部分已缓存）
  if (url.pathname === "/__gate/diag") {
    const cf = (request as Request & { cf?: { country?: string } }).cf;
    return Response.json(
      {
        country: cf?.country ?? "—",
        ip: request.headers.get("CF-Connecting-IP") || "—",
        ray: request.headers.get("CF-Ray") || "—",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    SKIP_PATHS.has(url.pathname) ||
    url.pathname.startsWith("/static/") ||
    url.pathname.startsWith("/api/ray/") // Ray ID 查询接口，供 check-ray-id 反查 Pages 侧请求
  ) {
    return next();
  }

  // images.limooo.cn：图片子域，公开访问（不过人机验证）。URL 不带 /static 前缀：
  // /portfolio/x.webp → /static/portfolio/x.webp；/ 与三个前端路径（SPA）出
  // 预渲染门面页（继承 base.html）；/api/*（i18n 等）交给 Functions 正常处理。
  if (url.hostname === "images.limooo.cn") {
    if (url.pathname.startsWith("/api/")) return next();
    const lang = detectLang(request);
    const clean = url.pathname.replace(/\/+$/, "") || "/";
    const isPage =
      clean === "/" ||
      clean === "/index.html" ||
      clean === "/portfolio" ||
      clean === "/qr-codes" ||
      clean === "/icons";
    const asset = isPage ? `/${lang}/images.html` : "/static" + url.pathname;
    if (env.ASSETS) {
      const resp = await env.ASSETS.fetch(new URL(asset, "https://limooo.cn/"));
      if (resp.ok) {
        if (isPage) {
          return withLangCookie(request, new Response(resp.body, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "private, max-age=300",
              // 语言由 cookie 决定：缓存必须按 cookie 区分
              "Vary": "Cookie",
            },
          }));
        }
        return new Response(resp.body, {
          headers: {
            "Content-Type": resp.headers.get("Content-Type") ?? "",
            "Cache-Control": "public, max-age=2592000",
            "ETag": resp.headers.get("ETag") ?? "",
          },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  // www 保持原 nginx 行为：先 301 到主站（保留路径），再由主站决定是否送门禁
  if (url.hostname === "www.limooo.cn") {
    return withLangCookie(request, new Response(null, {
      status: 301,
      headers: {
        Location: `https://limooo.cn${url.pathname}${url.search}`,
        "Cache-Control": "no-store",
      },
    }));
  }

  // 应用层封禁（放行登录/管理路径，避免管理员从被封 IP 无法登录）
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const whitelisted = GATE_WHITELIST.has(ip);
  const trustedCrawler = isTrustedCrawler(request);
  const exempt =
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/logout") ||
    url.pathname.startsWith("/appleid") ||
    url.pathname.startsWith("/visitor") ||
    url.pathname.startsWith("/api/appleid") ||
    url.pathname.startsWith("/api/auth") ||
    url.pathname.startsWith("/api/ray");
  if (!whitelisted && !trustedCrawler && !exempt && ip && (await isBlocked(env, request, ip))) {
    return new Response("Forbidden", { status: 403 });
  }

  const cookie = getCookie(GATE_COOKIE, request.headers.get("Cookie"));
  // 低风险（中国电信/移动/联通 ASN）由 Cloudflare 非交互挑战（js_challenge）先行过滤，
  // 通过后浏览器带 cf_clearance（苹果设备走 PAT 通道同样签发），视为已验证直接放行，
  // 不再重复跳 auth.limooo.cn/__gate 的 Turnstile 门禁。
  const cfCleared = (request.headers.get("Cookie") ?? "").includes("cf_clearance=");
  const gated = !(
    whitelisted ||
    trustedCrawler ||
    cfCleared ||
    (cookie && (await isValidGateCookie(cookie, env.GATE_HMAC_KEY)))
  );

  if (!gated) {
    // 已通过门禁；若还停在验证子域，送回原主机原路径
    if (url.hostname === GATE_HOST) {
      const back = safeNextPath(url.searchParams.get("next") ?? "/");
      const host = sanitizeHost(url.searchParams.get("host"));
      let resp = Response.redirect(viaRedirect(host, back), 302);
      // 白名单 / cf_clearance 放行时浏览器没有 __gate cookie（未走 Turnstile）；
      // 必须补发一个，否则 VPS nginx auth_request 会再次 302 回 auth，形成死循环。
      // Response.redirect 的响应头不可变，需拷贝后重建（与 withLangCookie 同理）。
      if (!cookie || !(await isValidGateCookie(cookie, env.GATE_HMAC_KEY))) {
        const headers = new Headers(resp.headers);
        headers.append("Set-Cookie", await mintGateCookie(env.GATE_HMAC_KEY));
        resp = new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
      return withLangCookie(request, resp);
    }
    // 干净 URL：按语言从预渲染产物取内容，URL 保持 /、/services、/contact 或子域根
    const asset = pageAsset(url.hostname, url.pathname, detectLang(request));
    if (asset && env.ASSETS) {
      // 管理端子域（visitor/appleid）未登录直接跳登录页，避免先闪一版空框架
      if (
        (url.hostname === "visitor.limooo.cn" || url.hostname === "appleid.limooo.cn") &&
        !(await requireAuth(env, request))
      ) {
        // Response.redirect 要求绝对 URL，这里用 Location 头（允许站内相对路径）
        return withLangCookie(
          request,
          new Response(null, {
            status: 302,
            headers: {
              Location: `/login?next=${encodeURIComponent(`https://${url.hostname}${url.pathname}${url.search}`)}`,
            },
          }),
        );
      }
      const resp = await env.ASSETS.fetch(new URL(asset, "https://limooo.cn/"));
      if (resp.ok) {
        return withLangCookie(request, new Response(resp.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, max-age=300",
            // 语言由 cookie 决定：缓存必须按 cookie 区分，否则切换语言后刷新会命中旧语言缓存
            "Vary": "Cookie",
          },
        }));
      }
    }
    return next();
  }

  // 未验证：只在 auth.limooo.cn 渲染门禁页，其它主机 302 过去（附原始主机+路径）
  if (url.hostname !== GATE_HOST) {
    const gateUrl = new URL("/__gate", `https://${GATE_HOST}/`);
    gateUrl.searchParams.set("host", url.hostname);
    gateUrl.searchParams.set("next", url.pathname + url.search);
    await logEvent(env, "gate_redirect", request, {
      outcome: "unverified",
      status: 302,
      path: url.pathname,
      message: "redirect_to_gate",
    });
    return withLangCookie(request, new Response(null, {
      status: 302,
      headers: {
        Location: gateUrl.toString(),
        "Cache-Control": "no-store",
      },
    }));
  }

  return renderGatePage(context, {
    host: url.searchParams.get("host") ?? undefined,
    next: url.searchParams.get("next") ?? "/",
  });
};
