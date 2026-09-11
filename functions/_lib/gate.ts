/** 人机验证门禁：cookie 校验/签发、Turnstile 验证、门禁页渲染、配置接口。 */

import { queryAll } from "./d1";
import { networkAddress, normalizeIp } from "./cidr";
import { logEvent } from "./logging";
import type { RequestContext } from "./routing";
import {
  detectLang,
  getCookie,
  safeNextPath,
  sanitizeHost,
  withLangCookie,
} from "./routing";
import {
  BASE_URL,
  GATE_COOKIE,
  GATE_TTL_SECONDS,
  LANG_COOKIE,
  ROOT_DOMAIN,
} from "./config";
import { GATE_I18N } from "../_data/runtime";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 3000;
const textEncoder = new TextEncoder();

/** 门禁事件日志异步写入，不阻塞验证结果的返回。 */
function deferLog(context: RequestContext, promise: Promise<unknown>): void {
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
  } else {
    void promise;
  }
}

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

/** cookie 格式：<过期时间戳>.<HMAC-SHA256 hex 签名>。 */
export async function isValidGateCookie(
  value: string | undefined,
  key: string,
): Promise<boolean> {
  if (!value || !key) return false;
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

/** 签发 __gate cookie（Domain=. <root_domain>，TTL 来自契约）。 */
export async function mintGateCookie(key: string): Promise<string> {
  const ttlSeconds = GATE_TTL_SECONDS;
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmacSha256Hex(key, String(expiry));
  return `${GATE_COOKIE}=${expiry}.${signature}; Domain=.${ROOT_DOMAIN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
}

/** GET /__gate/config：只下发非敏感运行时配置，不写死 sitekey 到 HTML。 */
export function handleGateConfig(context: RequestContext): Response {
  const { env, request } = context;
  return Response.json(
    {
      sitekey: env.TURNSTILE_SITEKEY ?? "",
      i18n: GATE_I18N,
      lang: detectLang(request),
      root_domain: ROOT_DOMAIN,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** GET /__gate/diag：动态诊断信息，页面其余部分可缓存。 */
export function handleGateDiag(context: RequestContext): Response {
  const { request } = context;
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

export interface GateRenderOptions {
  next?: string;
  host?: string;
  errorKey?: string;
  unavailable?: boolean;
}

/** 从生成好的 <lang>/auth.html 读取门禁页，只注入 host/next/error/lang。 */
export async function renderGatePage(
  context: RequestContext,
  opts: GateRenderOptions,
): Promise<Response> {
  const { request, env } = context;
  const host = sanitizeHost(opts.host);
  const next = safeNextPath(opts.next ?? "/");
  const lang = detectLang(request);
  const status = opts.unavailable ? 503 : 403;
  if (!env.ASSETS) return new Response("Gate page unavailable", { status: 503 });

  const asset = await env.ASSETS.fetch(new URL(`/${lang}/auth.html`, BASE_URL));
  if (!asset.ok) return new Response("Gate page unavailable", { status: 503 });
  const source = await asset.text();
  const html = source
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{host}}", escapeHtml(host))
    .replaceAll("{{next}}", escapeHtml(next))
    .replaceAll("{{error}}", escapeHtml(opts.errorKey ?? ""));

  const hasLangCookie = Boolean(getCookie(LANG_COOKIE, request.headers.get("Cookie")));
  const cacheControl =
    opts.errorKey || !env.TURNSTILE_SITEKEY
      ? "no-store"
      : hasLangCookie
        ? "public, max-age=300"
        : "private, max-age=300";

  return withLangCookie(
    request,
    new Response(html, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": cacheControl,
        "Vary": "Cookie",
      },
    }),
  );
}

interface BlockedRow {
  cidr: string;
  network: string;
  prefix: number;
}

/**
 * 记录未通过门禁的来源；同一 IP 在 24 小时内第 3 次失败时精确封禁该 IP。
 *
 * 计数只保存 HMAC 后的 IP，封禁时才把规范化地址写入 blocked_ips。成功写入
 * blocked_ips 后删除计数器，避免被封来源继续占用表空间或反复触发封禁审计。
 */
/* Automatic gate-failure threshold blocking has been removed. */
async function removedBanAfterGateFailures(
  _env: import("./env").Env,
  _request: Request,
  _ip: string,
): Promise<boolean> {
  return false;
/*
  if (!env.DB || !env.OBSERVABILITY_HMAC_KEY) return false;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const parsed = parseCidr(normalized);
  if (!parsed) return false;

  const hashedIp = await ipHash(normalized, env);
  if (!hashedIp) return false;

  try {
    const rows = await queryAll<{ failures: number }>(
      env.DB,
      `INSERT INTO gate_failures (ip_hash, failures, window_started_at, last_seen_at)
       VALUES (?, 1, unixepoch(), unixepoch())
       ON CONFLICT(ip_hash) DO UPDATE SET
         failures = CASE
           WHEN gate_failures.last_seen_at < unixepoch() - ? THEN 1
           ELSE gate_failures.failures + 1
         END,
         window_started_at = CASE
           WHEN gate_failures.last_seen_at < unixepoch() - ? THEN unixepoch()
           ELSE gate_failures.window_started_at
         END,
         last_seen_at = unixepoch()
       RETURNING failures`,
      hashedIp,
      GATE_FAILURE_WINDOW_SECONDS,
      GATE_FAILURE_WINDOW_SECONDS,
    );
    if ((rows[0]?.failures ?? 0) < GATE_FAILURE_BAN_THRESHOLD) return false;

    const now = "datetime('now')";
    const reason = `${GATE_FAILURE_BAN_THRESHOLD} unverified gate requests within 24h`;
    const mutationSql =
      `INSERT INTO blocked_ips
         (cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active)
       VALUES (?, ?, ?, ?, 'gate/threshold', ${now}, ${now}, 'gate-threshold', 1)
       ON CONFLICT(cidr) DO UPDATE SET
         network = excluded.network, prefix = excluded.prefix, reason = excluded.reason,
         source = 'gate/threshold', updated_at = excluded.updated_at,
         updated_by = 'gate-threshold', active = 1`;
    const auditSql =
      `INSERT INTO blocklist_audit
         (cidr, network, prefix, action, actor, reason, source, previous_reason,
          previous_source, previous_updated_at, created_at)
       VALUES (?, ?, ?, 'threshold_block', 'gate-threshold', ?, 'gate/threshold',
               '', '', '', ${now})`;
    const clearSql = "DELETE FROM gate_failures WHERE ip_hash = ?";
    const statements = [
      env.DB.prepare(mutationSql).bind(parsed.cidr, parsed.network, parsed.prefix, reason),
      env.DB.prepare(auditSql).bind(parsed.cidr, parsed.network, parsed.prefix, reason),
      env.DB.prepare(clearSql).bind(hashedIp),
    ];
    const batched = await executeBatch(env.DB, statements);
    if (!batched) {
      if (!(await execute(env.DB, mutationSql, parsed.cidr, parsed.network, parsed.prefix, reason))) return false;
      if (!(await execute(env.DB, auditSql, parsed.cidr, parsed.network, parsed.prefix, reason))) return false;
      if (!(await execute(env.DB, clearSql, hashedIp))) return false;
    }
    await logEvent(env, "gate_threshold_block", request, {
      outcome: "blocked",
      status: 403,
      ip: normalized,
      message: `cidr=${parsed.cidr}; failures=${GATE_FAILURE_BAN_THRESHOLD}`,
    });
    return true;
  } catch {
    // 封禁计数不可用时维持门禁原有行为，不能误封。
    return false;
  }*/
}

/** 封禁检查：规范化请求 IP 后，按 blocked_ips(network, prefix) 精确查询（DB 异常时放行）。 */
export async function isBlocked(
  env: { DB?: import("./env").Env["DB"] },
  request: Request,
  ip: string,
): Promise<boolean> {
  if (!env.DB || !ip) return false;
  const url = new URL(request.url);
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const maxPrefix = normalized.includes(":") ? 128 : 32;
  const candidates: Array<[string, number]> = [];
  for (let prefix = 0; prefix <= maxPrefix; prefix++) {
    const network = networkAddress(normalized, prefix);
    if (network) candidates.push([network, prefix]);
  }
  try {
    let matched: BlockedRow | null = null;
    // 每对 network/prefix 占两个绑定参数；49 对可保持在 D1 单语句 100 参数限制内。
    // 因而 IPv4 只需一次查询，IPv6 由原先七次降为三次。
    for (let start = 0; start < candidates.length; start += 49) {
      const chunk = candidates.slice(start, start + 49);
      const conditions = chunk.map(() => "(network = ? AND prefix = ?)").join(" OR ");
      const rows = await queryAll<BlockedRow>(
        env.DB,
        `SELECT cidr, network, prefix
         FROM blocked_ips
         WHERE active = 1 AND (${conditions})
         ORDER BY prefix DESC
         LIMIT 1`,
        ...chunk.flatMap(([network, prefix]) => [network, prefix]),
      );
      for (const row of rows) {
        if (!matched || row.prefix > matched.prefix) matched = row;
      }
    }
    if (matched) {
      await logEvent(env as never, "block_match", request, {
        ip: normalized,
        path: url.pathname,
        outcome: "blocked",
        status: 403,
        message: `cidr=${matched.cidr}`,
      });
      return true;
    }
  } catch {
    // fail-open：DB 不可用时不做应用层拦截。
  }
  return false;
}

async function verifyTurnstile(
  token: string,
  remoteip: string,
  secret: string,
): Promise<boolean> {
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

function wantsJson(request: Request): boolean {
  return request.headers.get("Accept")?.includes("application/json") ?? false;
}

function gateTarget(host: string, path: string): string {
  return `https://${host}${path}`;
}

/** POST /__gate/verify：校验 Turnstile，成功签发 cookie。
 *
 * 门禁页通过 fetch 调用本接口，响应只写 Cookie，不经过 redirect 子域；
 * 无 JavaScript 时仍直接回原站，作为可访问性降级。
 */
export async function handleVerify(context: RequestContext): Promise<Response> {
  const { request, env } = context;
  const startedAt = Date.now();
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    deferLog(
      context,
      logEvent(env, "gate_verify", request, {
        outcome: "failed",
        status: 400,
        durationMs: Date.now() - startedAt,
        message: "invalid_form",
      }),
    );
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
    deferLog(
      context,
      logEvent(env, "gate_verify", request, {
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
      }),
    );
    const errorKey = unavailable ? "unavailable" : "failed";
    if (wantsJson(request)) {
      return Response.json(
        { ok: false, error: errorKey },
        { status: unavailable ? 503 : 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    return renderGatePage(context, {
      host,
      next,
      unavailable,
      errorKey,
    });
  }

  const cookie = await mintGateCookie(env.GATE_HMAC_KEY);
  deferLog(
    context,
    logEvent(env, "gate_verify", request, {
      outcome: "success",
      status: 204,
      durationMs: Date.now() - startedAt,
      message: "cookie_issued",
    }),
  );

  // 验证成功只签发 __gate cookie；若再叠加语言 cookie，Workers 会把两条
  // Set-Cookie 合并，Safari 只认第一条。
  if (wantsJson(request)) {
    return new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": cookie,
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: gateTarget(host, next),
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  });
}
