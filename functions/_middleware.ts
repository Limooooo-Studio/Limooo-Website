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
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 8000;

// 不能被门禁拦截的路径（否则死循环）
const SKIP_PATHS = new Set<string>([
  "/__gate/verify",
  "/Limooo-xtext.webp",
  "/favicon.ico",
]);

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

// 多语言（与原 Flask 端一致：cookie > Accept-Language > IP 地区 > en-US）
const SUPPORTED_LANGS = ["zh-CN", "en-US", "ja-JP", "ko-KR"];
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

/** 语言检测：cookie > Accept-Language(zh/en/ja/ko) > CF 地区(CN/JP/KR) > en-US */
function detectLang(request: Request): string {
  const cookie = getCookie(LANG_COOKIE, request.headers.get("Cookie"));
  if (cookie && SUPPORTED_LANGS.includes(cookie)) return cookie;

  const accept = request.headers.get("Accept-Language") ?? "";
  for (const part of accept.split(",")) {
    const p = part.trim().split(";")[0].toLowerCase();
    if (p.startsWith("zh")) return "zh-CN";
    if (p.startsWith("en")) return "en-US";
    if (p.startsWith("ja")) return "ja-JP";
    if (p.startsWith("ko")) return "ko-KR";
  }

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const byCountry: Record<string, string> = { CN: "zh-CN", JP: "ja-JP", KR: "ko-KR" };
  if (cf?.country && byCountry[cf.country]) return byCountry[cf.country];
  return "en-US";
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

interface GateRenderOptions {
  next?: string;
  host?: string;
  error?: string;
  unavailable?: boolean;
}

function renderGatePage(context: EventContext, opts: GateRenderOptions): Response {
  const { request, env } = context;
  const url = new URL(request.url);
  const host = sanitizeHost(opts.host);
  const next = safeNextPath(opts.next ?? "/");

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const country = cf?.country ?? "—";
  const ip = request.headers.get("CF-Connecting-IP") || "—";
  const ray = request.headers.get("CF-Ray") || "—";
  const sitekey = env.TURNSTILE_SITEKEY ?? "";
  const status = opts.unavailable ? 503 : 403;

  const errorHtml = opts.error
    ? `<div class="error">${escapeHtml(opts.error)}</div>`
    : "";
  const turnstileHtml = sitekey
    ? `<div id="turnstile-wrap"></div>`
    : `<div class="error">Server configuration error: TURNSTILE_SITEKEY is not set.</div>`;
  const turnstileSrc = sitekey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#17181c">
<title>Verify you are human · Limooo</title>
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
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  }
  .light-mode {
    color-scheme: light;
    --bg-a: #f3f4f6; --bg-b: #e5e7eb;
    --text: #1f2328; --muted: #6b7280;
    --line: #e2e2e3; --panel: #ffffff; --highlight: #f2f2f3;
    --foot: #9ca3af;
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
  /* 深浅切换（与主站同款：图标变色 + active 缩放；轨道/背景不用强调色） */
  .theme-btn {
    position: fixed; top: 18px; right: 18px; z-index: 10;
    width: 40px; height: 40px; border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    background: var(--panel); color: var(--text);
    border: 1px solid var(--line); cursor: pointer;
    transition: transform 160ms var(--ease-out), background 160ms var(--ease-out),
      color 160ms var(--ease-out), border-color 160ms var(--ease-out);
  }
  .theme-btn:hover { background: var(--highlight); }
  .theme-btn:hover svg { color: var(--accent); }
  .theme-btn:active { transform: scale(0.92); color: var(--accent); }
  .theme-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .theme-btn svg {
    position: absolute; width: 19px; height: 19px;
    transition: opacity 250ms ease-out, transform 400ms var(--ease-out);
  }
  .theme-btn .icon-sun { opacity: 0; transform: rotate(-90deg) scale(0.5); }
  .theme-btn .icon-moon { opacity: 1; transform: rotate(0) scale(1); }
  .light-mode .theme-btn .icon-sun { opacity: 1; transform: rotate(0) scale(1); }
  .light-mode .theme-btn .icon-moon { opacity: 0; transform: rotate(90deg) scale(0.5); }
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
<button class="theme-btn" type="button" role="switch" aria-checked="true" aria-label="Toggle theme" onclick="toggleTheme()">
  <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
  <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
</button>
<main class="card">
  <img class="logo" src="/Limooo-xtext.webp" alt="LIMOOO" width="220">
  <h1>Please complete this CAPTCHA to access the site.</h1>
  ${errorHtml}
  <form id="gate" method="post" action="/__gate/verify">
    <input type="hidden" name="host" value="${escapeHtml(host)}">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <div class="turnstile-wrap">${turnstileHtml}</div>
  </form>
  <hr class="divider">
  <dl class="diag">
    <dt>Location:</dt><dd>${escapeHtml(country)}</dd>
    <dt>IP:</dt><dd>${escapeHtml(ip)}</dd>
    <dt>Ray ID:</dt><dd>${escapeHtml(ray)}</dd>
  </dl>
  <p class="foot">Secured by <strong>Limooo</strong> Edge Security</p>
</main>
${turnstileSrc}
<script>
  var turnstileWidget = null;

  function onTurnstileSuccess() {
    document.getElementById("gate").submit();
  }
  function getSystemTheme() {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function effectiveTheme() {
    var saved = localStorage.getItem("theme");
    return (saved === "light" || saved === "dark") ? saved : getSystemTheme();
  }
  function applyTheme(theme) {
    document.documentElement.classList.toggle("light-mode", theme === "light");
    document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#ffffff" : "#17181c";
    var btn = document.querySelector(".theme-btn");
    if (btn) btn.setAttribute("aria-checked", theme === "dark" ? "true" : "false");
  }
  function toggleTheme() {
    var next = effectiveTheme() === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    applyTheme(next);
    if (turnstileWidget && window.turnstile) {
      window.turnstile.reset(turnstileWidget, { theme: next === "light" ? "light" : "dark" });
    }
  }
  function onloadTurnstileCallback() {
    var wrap = document.getElementById("turnstile-wrap");
    if (window.turnstile && wrap) {
      turnstileWidget = window.turnstile.render(wrap, {
        sitekey: ${JSON.stringify(sitekey)},
        callback: onTurnstileSuccess,
        theme: effectiveTheme() === "light" ? "light" : "dark"
      });
    }
  }
  // 初始同步主题（Turnstile 由 onloadTurnstileCallback 显式渲染）
  applyTheme(effectiveTheme());
</script>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
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
    return renderGatePage(context, { error: "Invalid request. Please try again." });
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
      error: unavailable
        ? "Verification service temporarily unavailable. Please try again in a moment."
        : "Verification failed. Please try again.",
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
  const { request, env, next } = context;
  const url = new URL(request.url);

  // /__gate/verify 与静态放行路径不能被门禁拦（否则死循环）
  if (url.pathname === "/__gate/verify") {
    return handleVerify(context);
  }
  if (SKIP_PATHS.has(url.pathname)) {
    return next();
  }

  // www 保持原 nginx 行为：先 301 到主站（保留路径），再由主站决定是否送门禁
  if (url.hostname === "www.limooo.cn") {
    return new Response(null, {
      status: 301,
      headers: {
        Location: `https://limooo.cn${url.pathname}${url.search}`,
        "Cache-Control": "no-store",
      },
    });
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
      return Response.redirect(viaRedirect(host, back), 302);
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
      const resp = await env.ASSETS.fetch(new URL(asset, "https://limooo.cn/"));
      if (resp.ok) {
        return new Response(resp.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, max-age=300",
          },
        });
      }
    }
    return next();
  }

  // 未验证：只在 auth.limooo.cn 渲染门禁页，其它主机 302 过去（附原始主机+路径）
  if (url.hostname !== GATE_HOST) {
    const gateUrl = new URL("/__gate", `https://${GATE_HOST}/`);
    gateUrl.searchParams.set("host", url.hostname);
    gateUrl.searchParams.set("next", url.pathname + url.search);
    return new Response(null, {
      status: 302,
      headers: {
        Location: gateUrl.toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  return renderGatePage(context, {
    host: url.searchParams.get("host") ?? undefined,
    next: url.searchParams.get("next") ?? "/",
  });
};
