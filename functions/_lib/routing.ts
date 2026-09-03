/** 请求路由 / 语言 / 站内跳转工具（无浏览器 DOM 依赖，可被 vitest 直接 import）。 */

import type { Env } from "./env";
import { contains, normalizeIp } from "./cidr";
import { GATE_TRUST_IPS, GATE_TRUST_NETWORKS } from "../_data/gateTrust";
import {
  BASE_URL,
  LANG_COOKIE,
  LANG_COOKIE_MAX_AGE,
  PAGE_ROUTES,
  PUBLIC_HOSTS,
  REDIRECT_HOST,
  ROOT_DOMAIN,
  SHARED_LANG_HOSTS,
  SUPPORTED_LANGS,
} from "./config";

export interface RequestContext {
  request: Request;
  env: Env;
  next(): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
}

/** 不能被门禁拦截的路径（否则死循环）。 */
export const SKIP_PATHS = new Set<string>([
  "/__gate/verify",
  "/__gate/diag",
  "/__gate/config",
  "/Limooo-xtext.svg",
  "/favicon.ico",
]);

/** 门禁/封禁白名单：只认 data/whitelist.txt 生成的门禁信任配置。 */
export function isGateTrustedIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  if (GATE_TRUST_IPS.has(normalized)) return true;
  return GATE_TRUST_NETWORKS.some(([network, prefix]) =>
    contains(network, Number(prefix), normalized),
  );
}

export function getCookie(name: string, header: string | null): string | undefined {
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

/** 只允许站内相对路径：以 / 开头、拒绝 //、反斜杠和任何协议前缀。 */
export function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "/";
  return raw.slice(0, 2048);
}

/** 登录/登出回跳：站内相对路径，或仅允许 https + 白名单主机。 */
export function safeNextUrl(raw: string | null): string {
  const fallback = `${BASE_URL}/`;
  if (!raw || raw.length > 2048) return fallback;
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  try {
    const value = new URL(raw);
    if (value.protocol === "https:" && isPublicHost(value.hostname)) return raw;
  } catch {
    // 非 URL 一律回主站。
  }
  return fallback;
}

/** 门禁/登录回跳白名单：精确主机名，或配置里 *.limooo.cn 形式的通配子域。 */
export function isPublicHost(host: string): boolean {
  if (!host) return false;
  if (PUBLIC_HOSTS.has(host)) return true;
  for (const entry of PUBLIC_HOSTS) {
    if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return true;
  }
  return false;
}

/** 把站内路径包装成经 redirect.<root_domain> 的中转跳转。 */
export function viaRedirect(host: string, path: string): string {
  return `${REDIRECT_HOST}?to=${encodeURIComponent(`https://${host}${path}`)}`;
}

/** 门禁回跳目标主机只允许公开白名单，其余一律回主站。 */
export function sanitizeHost(raw: string | null | undefined): string {
  return raw && isPublicHost(raw) ? raw : ROOT_DOMAIN;
}

/** 语言检测：cookie > Accept-Language(zh/en/ja/ko) > CF 地区(CN/JP/KR) > default。 */
export function detectLang(request: Request): (typeof SUPPORTED_LANGS)[number] {
  const host = (request.headers.get("Host") ?? new URL(request.url).hostname).split(":")[0];
  // 仅共享语言的主域读取主站 cookie（visitor/appleid/status 等各自独立）
  if (SHARED_LANG_HOSTS.has(host)) {
    const cookie = getCookie(LANG_COOKIE, request.headers.get("Cookie"));
    if (
      cookie &&
      SUPPORTED_LANGS.includes(cookie.toLowerCase() as (typeof SUPPORTED_LANGS)[number])
    ) {
      return cookie.toLowerCase() as (typeof SUPPORTED_LANGS)[number];
    }
  }

  const accept = request.headers.get("Accept-Language") ?? "";
  for (const part of accept.split(",")) {
    const p = part.trim().split(";")[0].toLowerCase();
    if (p.startsWith("zh")) return "zh-cn";
    if (p.startsWith("en")) return "en-us";
    if (p.startsWith("ja")) return "ja-jp";
    if (p.startsWith("ko")) return "ko-kr";
  }

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const byCountry: Record<string, (typeof SUPPORTED_LANGS)[number]> = {
    CN: "zh-cn",
    JP: "ja-jp",
    KR: "ko-kr",
  };
  if (cf?.country && byCountry[cf.country]) return byCountry[cf.country];
  return SUPPORTED_LANGS.includes("en-us") ? "en-us" : SUPPORTED_LANGS[0];
}

/** 语言 cookie（跨 .<root_domain> 子域共享）。 */
export function langCookieHeader(host: string, lang: string): string {
  const bareHost = host.split(":")[0] ?? "";
  const domain =
    bareHost === ROOT_DOMAIN || bareHost.endsWith(`.${ROOT_DOMAIN}`)
      ? `Domain=.${ROOT_DOMAIN}; `
      : "";
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax; Secure; ${domain}`;
}

/** 复制响应头时保留多条 Set-Cookie，避免 Safari 只认第一条。 */
export function preserveSetCookie(headers: Headers, source: Headers): void {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(source) : [];
  if (!cookies.length) return;
  headers.delete("Set-Cookie");
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
}

/** 首次访问时把检测出的语言写回；不能原地修改不可变响应头。 */
export function withLangCookie(request: Request, resp: Response): Response {
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

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** 主机+路径 → 应吐出的语言页面资产；静态资源等返回 null，交回 next()。 */
export function pageAsset(host: string, pathname: string, lang: string): string | null {
  const file = PAGE_ROUTES[host]?.[normalizedPath(pathname)];
  return file ? `/${lang}/${file}` : null;
}

/** 是否属于公开静态资源/内部路径，避免门禁死循环和重复埋点。 */
export function isPublicAssetPath(pathname: string): boolean {
  return (
    SKIP_PATHS.has(pathname) ||
    pathname.startsWith("/static/") ||
    pathname === "/favicon.ico" ||
    pathname === "/Limooo-xtext.svg"
  );
}

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}
