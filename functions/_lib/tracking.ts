/**
 * Limooo 访客 / Ray 埋点（仅最小字段）。
 *
 * 隐私约定：
 * - visitors_v2 / ray_log_v2 不保存完整 IP、UA 或 query；
 * - IP 使用独立 OBSERVABILITY_HMAC_KEY 的 HMAC 前 16 位；
 * - 埋点失败只输出控制台，不阻塞业务、不递归写错误事件。
 */

import { execute } from "./d1";
import type { Env } from "./env";
import { ipHash } from "./logging";
import { GATE_TRUST } from "../_data/gateTrust";
import { IMAGES_HOSTNAME, REDIRECT_HOSTNAME } from "./config";

let trackingSchemaReady = false;

const TRACKING_DDL = [
  `CREATE TABLE IF NOT EXISTS visitors_v2 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash     TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL DEFAULT '',
    status      INTEGER NOT NULL DEFAULT 0,
    ts          INTEGER NOT NULL DEFAULT (unixepoch()),
    page_slug   TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_visitors_v2_ts ON visitors_v2 (ts)",
  "CREATE INDEX IF NOT EXISTS idx_visitors_v2_ip_hash_ts ON visitors_v2 (ip_hash, ts)",
  "CREATE INDEX IF NOT EXISTS idx_visitors_v2_page_slug_ts ON visitors_v2 (page_slug, ts)",
  `CREATE TABLE IF NOT EXISTS ray_log_v2 (
    ray             TEXT PRIMARY KEY,
    ts              INTEGER NOT NULL DEFAULT (unixepoch()),
    host            TEXT NOT NULL DEFAULT '',
    normalized_path TEXT NOT NULL DEFAULT '',
    method          TEXT NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    ip_hash         TEXT NOT NULL DEFAULT '',
    country         TEXT NOT NULL DEFAULT '',
    ua_family       TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_ray_log_v2_ts ON ray_log_v2 (ts)",
  "CREATE INDEX IF NOT EXISTS idx_ray_log_v2_host_ts ON ray_log_v2 (host, ts)",
];

export function isTrustedCrawler(request: Request): boolean {
  const cf = (request as Request & { cf?: { botManagement?: { verifiedBot?: boolean } } }).cf;
  if (GATE_TRUST.verified_bot !== true) return false;
  return cf?.botManagement?.verifiedBot === true;
}

/** 去掉参数后的规范化路径，限制长度，避免超长/恶意路径拖垮 D1。 */
export function normalizePath(pathname: string): string {
  return pathname.split("?")[0].slice(0, 2048);
}

/** 访问路径 → 便于聚合的页面 slug。 */
export function pageSlug(pathname: string): string {
  const p = normalizePath(pathname).replace(/\/+$/, "") || "/";
  if (p === "/" || p === "/index.html") return "home";
  if (p.startsWith("/services")) return "services";
  if (p.startsWith("/contact")) return "contact";
  if (p.startsWith("/visitor")) return "visitor";
  if (p.startsWith("/appleid")) return "appleid";
  if (p.startsWith("/login")) return "login";
  if (p.startsWith("/logout")) return "logout";
  const first = p.split("/").filter(Boolean)[0];
  return first || "root";
}

/** UA 白名单枚举：只保留有限分类，不落原始 UA。 */
export function uaFamily(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (!ua) return "";
  const bots: Array<[RegExp, string]> = [
    [/googlebot/, "googlebot"],
    [/bingbot/, "bingbot"],
    [/baiduspider/, "baiduspider"],
    [/yandex/, "yandexbot"],
    [/applebot/, "applebot"],
    [/gptbot|chatgpt-|oai-searchbot/, "ai-bot"],
    [/claudebot|anthropic-ai|claude-web/, "ai-bot"],
    [/perplexitybot|amazonbot|ccbot|diffbot/, "ai-bot"],
    [/uptimerobot|pingdom|gtmetrix|statuscake|datadog|zabbix/, "monitor"],
  ];
  for (const [re, name] of bots) if (re.test(ua)) return name;
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("chrome")) return "chrome";
  if (ua.includes("firefox")) return "firefox";
  if (ua.includes("safari")) return "safari";
  if (ua.includes("mobile")) return "mobile";
  return "other";
}

/** 访客统计只记录真实用户页面 GET；爬虫/静态/API/门禁/图片/跳转均不记。 */
export function shouldTrackVisit(request: Request, url: URL): boolean {
  if (request.method !== "GET") return false;
  if (isTrustedCrawler(request)) return false;
  if (url.hostname === IMAGES_HOSTNAME || url.hostname === REDIRECT_HOSTNAME) return false;
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
  return !/\.(png|webp|jpg|jpeg|gif|ico|svg|css|js|json|webmanifest|txt|xml)$/i.test(p);
}

/** Ray 记录只保留页面和少量入口；静态、全部 API、门禁与图片/跳转子域不记。 */
export function shouldTrackRay(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE") return false;
  if (url.hostname === IMAGES_HOSTNAME || url.hostname === REDIRECT_HOSTNAME) return false;
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/static/") || p.startsWith("/__gate")) return false;
  if (p.startsWith("/favicon") || p === "/Limooo-xtext.webp") return false;
  if (/\.(png|webp|jpg|jpeg|gif|ico|svg|css|js|json|webmanifest|txt|xml)$/i.test(p)) return false;
  return true;
}

async function ensureTrackingSchema(env: Env): Promise<void> {
  if (trackingSchemaReady || !env.DB) return;
  try {
    for (const sql of TRACKING_DDL) {
      if (!(await execute(env.DB, sql))) return;
    }
    trackingSchemaReady = true;
  } catch {
    // 下次请求重试；埋点失败不影响业务。
  }
}

/** 响应完成后记录访客；只写 ip_hash/country/status/ts/page_slug。 */
export async function recordVisit(env: Env, request: Request, status: number): Promise<void> {
  if (!env.DB) return;
  const url = new URL(request.url);
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  try {
    await ensureTrackingSchema(env);
    await execute(
      env.DB,
      "INSERT INTO visitors_v2 (ip_hash, country, status, ts, page_slug) VALUES (?, ?, ?, unixepoch(), ?)",
      await ipHash(request.headers.get("CF-Connecting-IP") ?? "", env),
      cf?.country ?? "",
      status,
      pageSlug(url.pathname),
    );
  } catch (error) {
    // 不递归写错误事件，仅保留 Pages 控制台。
    console.error(JSON.stringify({ event: "visit_record_error", message: String(error) }));
  }
}

/** 响应完成后记录 Ray 请求；只写 ray、时间、host、规范路径、方法、状态、耗时、ip_hash、country、ua_family。 */
export async function recordRay(
  env: Env,
  request: Request,
  status: number,
  durationMs: number,
): Promise<void> {
  if (!env.DB) return;
  const url = new URL(request.url);
  const ray = request.headers.get("CF-Ray") ?? "";
  if (!ray) return;
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  try {
    await ensureTrackingSchema(env);
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO ray_log_v2
        (ray, ts, host, normalized_path, method, status, duration_ms, ip_hash, country, ua_family)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?)`,
      ray,
      url.hostname,
      normalizePath(url.pathname),
      request.method,
      status,
      Math.max(0, Math.round(durationMs)),
      await ipHash(request.headers.get("CF-Connecting-IP") ?? "", env),
      cf?.country ?? "",
      uaFamily(request.headers.get("User-Agent") ?? ""),
    );
  } catch (error) {
    // fail-open + 不递归写错误事件。
    console.error(JSON.stringify({ event: "ray_record_error", message: String(error) }));
  }
}
