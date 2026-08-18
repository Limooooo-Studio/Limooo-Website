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
 *
 * 环境变量（在 Pages 项目设置里配成 Secret）：
 *   TURNSTILE_SITEKEY / TURNSTILE_SECRET / GATE_HMAC_KEY
 */

import { queryAll, execute } from "./_lib/d1";
import { requireAuth } from "./_lib/session";
import type { Env } from "./_lib/env";

interface EventContext {
  request: Request;
  env: Env;
  next(): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
}

type PagesFunction = (context: EventContext) => Promise<Response>;

const GATE_COOKIE = "__gate";
// 专用验证子域：门禁页只在这里渲染（Turnstile widget 只需允许该域名）
const GATE_HOST = "auth.limooo.cn";
// 统一跳转页（与 Flask 端 /r 共用同一服务，?to= 目标需为 https URL）
const REDIRECT_HOST = "https://redirect.limooo.cn/";
// 跳转子域：纯中转页，豁免人机验证（否则验证通过后经它回跳会再被拦，死循环）
const REDIRECT_HOSTNAME = "redirect.limooo.cn";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 8000;
// 地图瓦片上游（与 Flask 端一致：本域代理 CartoDB，避免跨域限制 + 统一缓存）
const TILE_UPSTREAMS: Record<string, string> = {
  dark: "https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all",
  light: "https://cartodb-basemaps-a.global.ssl.fastly.net/light_all",
};

// 不能被门禁拦截的路径（否则死循环）
const SKIP_PATHS = new Set<string>([
  "/__gate/verify",
  "/__gate/diag",
  "/Limooo-xtext.webp",
  "/favicon.ico",
]);
// /static/ 下的 CSS/图片等公开静态资源也放行：
// 主站页面本身已由门禁保护，但外部引用（如 authentik 登录页 logo 指向
// limooo.cn/static/...）不带 __gate cookie，被拦会 302 导致图片加载失败。

// 公开主机白名单：services/contact 子域直接出各自内容，www 301 到主站；
// identity/visitor/appleid 由 VPS 上的 nginx auth_request 跳到这里验证后原路返回
const PUBLIC_HOSTS = new Set([
  "limooo.cn",
  "www.limooo.cn",
  "services.limooo.cn",
  "contact.limooo.cn",
  "identity.limooo.cn",
  "visitor.limooo.cn",
  "appleid.limooo.cn",
]);

// 多语言（与原 Flask 端一致：cookie > Accept-Language > IP 地区 > en-us）
// 语言代码统一小写，与 Cloudflare Turnstile 的 language 参数格式一致
const SUPPORTED_LANGS = ["zh-cn", "en-us", "ja-jp", "ko-kr"];
const LANG_COOKIE = "user_lang_preference";

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

/** 首次访问（无语言 cookie）时把检测出的语言写回，此后各子域固定使用该语言 */
function withLangCookie(request: Request, resp: Response): Response {
  if (getCookie(LANG_COOKIE, request.headers.get("Cookie"))) return resp;
  resp.headers.append("Set-Cookie", langCookieHeader(request.headers.get("Host") ?? "", detectLang(request)));
  return resp;
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
async function isBlocked(env: Env, ip: string): Promise<boolean> {
  if (!env.DB || !ip) return false;
  try {
    const exact = await queryAll<{ cidr: string }>(
      env.DB,
      "SELECT cidr FROM blocked_ips WHERE cidr = ?",
      ip,
    );
    if (exact.length) return true;
    if (ip.split(".").length === 4) {
      const prefix = ip.split(".").slice(0, 3).join(".");
      const subnet = await queryAll<{ cidr: string }>(
        env.DB,
        "SELECT cidr FROM blocked_ips WHERE cidr = ?",
        `${prefix}.0/24`,
      );
      if (subnet.length) return true;
    }
  } catch {
    // fail-open：DB 不可用时不做应用层拦截
  }
  return false;
}

/** 访客前向统计：只记页面 GET（静态资源 / API / 门禁路径不记） */
async function recordVisit(env: Env, request: Request, pathname: string): Promise<void> {
  if (!env.DB || request.method !== "GET") return;
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/static/") ||
    pathname.startsWith("/__gate") ||
    pathname.startsWith("/tiles/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/Limooo-xtext.webp"
  ) {
    return;
  }
  if (/\.(png|webp|jpg|jpeg|gif|ico|svg|css|js|json|webmanifest|txt|xml)$/i.test(pathname)) {
    return;
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  try {
    await execute(
      env.DB,
      "INSERT INTO visitors (ip, country, path) VALUES (?, ?, ?)",
      ip,
      cf?.country ?? "",
      pathname,
    );
  } catch {
    // 埋点失败不阻塞请求
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

/** 验证页文案（与主站共用语言偏好：cookie > Accept-Language > CF 地区 > en-us） */
const GATE_I18N: Record<string, Record<string, string>> = {
  "zh-cn": {
    title: "人机验证 · Limooo",
    heading: "请完成人机验证后再访问本站",
    location: "位置",
    ip: "IP",
    ray: "Ray ID",
    foot: "由 Limooo 边缘安全提供保护",
    lang_aria: "切换语言",
    theme_aria: "切换主题",
    error_sitekey: "服务配置错误：未设置 TURNSTILE_SITEKEY。",
    error_invalid: "请求无效，请重试。",
    error_unavailable: "验证服务暂时不可用，请稍后重试。",
    error_failed: "验证未通过，请重试。",
  },
  "en-us": {
    title: "Verify you are human · Limooo",
    heading: "Please complete this CAPTCHA to access the site.",
    location: "Location",
    ip: "IP",
    ray: "Ray ID",
    foot: "Secured by Limooo Edge Security",
    lang_aria: "Switch language",
    theme_aria: "Toggle theme",
    error_sitekey: "Server configuration error: TURNSTILE_SITEKEY is not set.",
    error_invalid: "Invalid request. Please try again.",
    error_unavailable: "Verification service temporarily unavailable. Please try again in a moment.",
    error_failed: "Verification failed. Please try again.",
  },
  "ja-jp": {
    title: "人認証 · Limooo",
    heading: "このサイトにアクセスするには、人認証を完了してください",
    location: "場所",
    ip: "IP",
    ray: "Ray ID",
    foot: "Limooo Edge Security により保護されています",
    lang_aria: "言語切替",
    theme_aria: "テーマ切替",
    error_sitekey: "サーバー設定エラー：TURNSTILE_SITEKEY が設定されていません。",
    error_invalid: "リクエストが無効です。もう一度お試しください。",
    error_unavailable: "認証サービスが一時的に利用できません。しばらくしてからもう一度お試しください。",
    error_failed: "認証に失敗しました。もう一度お試しください。",
  },
  "ko-kr": {
    title: "휴먼 인증 · Limooo",
    heading: "사이트에 접속하려면 인증을 완료해 주세요",
    location: "위치",
    ip: "IP",
    ray: "Ray ID",
    foot: "Limooo Edge Security가 보호합니다",
    lang_aria: "언어 전환",
    theme_aria: "테마 전환",
    error_sitekey: "서버 설정 오류: TURNSTILE_SITEKEY가 설정되지 않았습니다.",
    error_invalid: "잘못된 요청입니다. 다시 시도해 주세요.",
    error_unavailable: "인증 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    error_failed: "인증에 실패했습니다. 다시 시도해 주세요.",
  },
};

/** 跳转页文案（与 Flask locales 的 redirect_title/redirect_text 一致） */
const REDIRECT_I18N: Record<string, { title: string; text: string }> = {
  "zh-cn": { title: "正在跳转", text: "正在跳转…" },
  "en-us": { title: "Redirecting", text: "Redirecting…" },
  "ja-jp": { title: "リダイレクト中", text: "リダイレクト中…" },
  "ko-kr": { title: "리다이렉트 중", text: "리다이렉트 중…" },
};

/** redirect 页预热的 limooo.cn 主站作品图（与 Flask REDIRECT_PRELOAD_IMAGES 一致） */
const REDIRECT_PRELOAD_IMAGES = [
  "https://limooo.cn/static/portfolio/IMG_0203.webp",
  "https://limooo.cn/static/portfolio/IMG_0146.webp",
  "https://limooo.cn/static/portfolio/IMG_0130.webp",
  "https://limooo.cn/static/portfolio/IMG_0244.webp",
  "https://limooo.cn/static/portfolio/IMG_0115.webp",
  "https://limooo.cn/static/portfolio/IMG_0179.webp",
];

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
<meta name="theme-color" content="#17181c">
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
  }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: linear-gradient(180deg, var(--bg-a) 0%, var(--bg-b) 100%);
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
  <img class="logo" src="/Limooo-xtext.webp" alt="LIMOOO" width="220">
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
  <p class="foot" data-i18n="foot">${t("foot")}</p>
</main>
${turnstileSrc}
<script>
  var turnstileWidget = null;
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
    var mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.content = theme === "light" ? "#ffffff" : "#17181c";
    var sw = document.querySelector(".appearance-switch");
    if (sw) sw.setAttribute("aria-checked", theme === "dark" ? "true" : "false");
  }
  function resetTurnstile() {
    if (turnstileWidget && window.turnstile) {
      window.turnstile.reset(turnstileWidget, {
        theme: effectiveTheme() === "light" ? "light" : "dark",
        language: turnstileLang(CURRENT_LANG)
      });
    }
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
      el.textContent = t(el.getAttribute("data-i18n"));
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
    var wrap = document.getElementById("turnstile-wrap");
    if (window.turnstile && wrap) {
      turnstileWidget = window.turnstile.render(wrap, {
        sitekey: ${JSON.stringify(sitekey)},
        callback: onTurnstileSuccess,
        theme: effectiveTheme() === "light" ? "light" : "dark",
        language: turnstileLang(CURRENT_LANG)
      });
    }
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
<meta http-equiv="refresh" content="1; url=${escapeHtml(to)}">
<title>${t.title}</title>
    ${preloadLinks}
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #0f1216; color: #e5e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
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
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <div class="text">${t.text}</div>
  </div>
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

/** /tiles/<theme>/<z>/<x>/<y>.png：代理 CartoDB 地图瓦片（与 Flask proxy_tile 一致） */
async function proxyTile(pathname: string): Promise<Response> {
  const m = pathname.match(/^\/tiles\/(dark|light)\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) return new Response("Not Found", { status: 404 });
  const theme = m[1];
  const upstream = TILE_UPSTREAMS[theme];
  const url = `${upstream}/${m[2]}/${m[3]}/${m[4]}.png`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "limooo/1.0" },
      cf: { cacheTtl: 604800 },
    });
    if (!resp.ok) return new Response("", { status: 502 });
    return new Response(resp.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=604800",
      },
    });
  } catch {
    return new Response("", { status: 502 });
  }
}

/** POST /__gate/verify：校验 Turnstile，成功签发 cookie 并 302 回原路径 */
async function handleVerify(context: EventContext): Promise<Response> {
  const { request, env } = context;
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return renderGatePage(context, { errorKey: "invalid" });
  }

  const token = form.get("cf-turnstile-response")?.toString() ?? "";
  const next = safeNextPath(form.get("next")?.toString() ?? null);
  const host = sanitizeHost(form.get("host")?.toString() ?? null);
  const remoteip = request.headers.get("CF-Connecting-IP") ?? "";

  let success = false;
  let unavailable = false;
  try {
    success = token !== "" && (await verifyTurnstile(token, remoteip, env.TURNSTILE_SECRET));
  } catch {
    unavailable = true;
  }

  if (!success) {
    return renderGatePage(context, {
      host,
      next,
      unavailable,
      errorKey: unavailable ? "unavailable" : "failed",
    });
  }

  // 中国大陆用户单次认证 30 分钟；其它地区 5 分钟
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const ttlSeconds = cf?.country === "CN" ? 30 * 60 : 5 * 60;
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmacSha256Hex(env.GATE_HMAC_KEY, String(expiry));
  // Domain=.limooo.cn：验证页在 auth.limooo.cn 签发，主站子域都能识别
  const cookie =
    `${GATE_COOKIE}=${expiry}.${signature}; Domain=.limooo.cn; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;

  return withLangCookie(request, new Response(null, {
    status: 302,
    headers: {
      Location: viaRedirect(host, next),
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  }));
}

export const onRequest: PagesFunction = async (context) => {
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
    url.pathname.startsWith("/tiles/")
  ) {
    if (url.pathname.startsWith("/tiles/")) return proxyTile(url.pathname);
    return next();
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
  const exempt =
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/logout") ||
    url.pathname.startsWith("/appleid") ||
    url.pathname.startsWith("/visitor") ||
    url.pathname.startsWith("/api/appleid") ||
    url.pathname.startsWith("/api/auth");
  if (!exempt && ip && (await isBlocked(env, ip))) {
    return new Response("Forbidden", { status: 403 });
  }

  const cookie = getCookie(GATE_COOKIE, request.headers.get("Cookie"));
  const gated = !(cookie && (await isValidGateCookie(cookie, env.GATE_HMAC_KEY)));

  if (!gated) {
    // 已通过门禁；若还停在验证子域，送回原主机原路径
    if (url.hostname === GATE_HOST) {
      const back = safeNextPath(url.searchParams.get("next") ?? "/");
      const host = sanitizeHost(url.searchParams.get("host"));
      return withLangCookie(request, Response.redirect(viaRedirect(host, back), 302));
    }
    const record = recordVisit(env, request, url.pathname);
    if (typeof context.waitUntil === "function") {
      context.waitUntil(record);
    } else {
      void record;
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
            headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` },
          }),
        );
      }
      const resp = await env.ASSETS.fetch(new URL(asset, "https://limooo.cn/"));
      if (resp.ok) {
        return withLangCookie(request, new Response(resp.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, max-age=300",
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
