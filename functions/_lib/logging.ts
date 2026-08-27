/** 统一结构化事件日志（Pages Functions 侧）。
 *
 * 每个事件输出一行完整 JSON（字段与 Flask 侧 src/app.py 的 log_event 保持一致），
 * 并尝试写入 D1 events 表供行级查询与健康检查聚合。
 * 日志写入失败不影响业务请求。
 */

import { execute } from "./d1";
import type { Env } from "./env";

const textEncoder = new TextEncoder();
let eventSchemaReady = false;
const MAX_LOG_MESSAGE_LENGTH = 500;

const SENSITIVE_KEY_RE = /(password|passwd|token|secret|authorization|api[_-]?key|access[_-]?key|cookie|session)/i;
const SENSITIVE_ASSIGNMENT_RE =
  /(password|passwd|token|secret|authorization|api[_-]?key|access[_-]?key|cookie|session|__gate|limooo_session|limooo_pending)\s*=\s*[^&\s,;]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_STRING_RE = /\?[^\s"'<>]+/g;

export interface LogEventFields {
  outcome?: string;
  status?: number;
  host?: string;
  path?: string;
  method?: string;
  message?: string;
  durationMs?: number;
  ip?: string;
  country?: string;
  accountId?: number;
  actorSub?: string;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256Hex(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(value)));
  return toHex(sig);
}

/** 每个 isolate 首次写入前幂等建表，避免依赖人工先执行迁移。 */
async function ensureEventSchema(env: Env): Promise<void> {
  if (eventSchemaReady || !env.DB) return;
  const ddl = [
    `CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event       TEXT    NOT NULL,
      ts          INTEGER NOT NULL DEFAULT (unixepoch()),
      request_id  TEXT    DEFAULT '',
      host        TEXT    DEFAULT '',
      path        TEXT    DEFAULT '',
      method      TEXT    DEFAULT '',
      status      INTEGER DEFAULT 0,
      outcome     TEXT    DEFAULT '',
      ip_hash     TEXT    DEFAULT '',
      country     TEXT    DEFAULT '',
      duration_ms INTEGER DEFAULT 0,
      message     TEXT    DEFAULT '',
      account_id  TEXT    DEFAULT '',
      actor_sub   TEXT    DEFAULT ''
    )`,
    "CREATE INDEX IF NOT EXISTS idx_events_ts_event ON events (ts, event)",
    "CREATE INDEX IF NOT EXISTS idx_events_event_outcome_ts ON events (event, outcome, ts)",
    "CREATE INDEX IF NOT EXISTS idx_events_request_id ON events (request_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_ip_hash_ts ON events (ip_hash, ts)",
  ];
  try {
    for (const sql of ddl) {
      if (!(await execute(env.DB, sql))) return;
    }
    eventSchemaReady = true;
  } catch {
    // D1 尚未就绪时下一请求重试，不影响业务。
  }
}

/** request_id：优先使用 Cloudflare Ray ID，便于按边缘日志反查 */
export function requestId(request: Request): string {
  return request.headers.get("CF-Ray") ?? `pages-${crypto.randomUUID()}`;
}

/**
 * IP 脱敏：使用独立的 OBSERVABILITY_HMAC_KEY 做 HMAC-SHA256 并截取前 16 位。
 * 密钥缺失时返回空串（fail-closed），绝不复用 GATE_HMAC_KEY 或使用公开盐值。
 */
export async function ipHash(ip: string, env: Env): Promise<string> {
  if (!ip) return "";
  const key = env.OBSERVABILITY_HMAC_KEY;
  if (!key) return "";
  return (await hmacSha256Hex(key, ip)).slice(0, 16);
}

/** 日志文本脱敏：移除口令、token、Cookie、Bearer 与完整 query，避免敏感值落盘。 */
export function sanitizeLogMessage(message: string): string {
  let out = message
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(SENSITIVE_ASSIGNMENT_RE, "$1=[redacted]")
    .replace(QUERY_STRING_RE, "?[redacted]");
  if (SENSITIVE_KEY_RE.test(out)) {
    out = out.replace(
      /("(?:password|passwd|token|secret|authorization|api[_-]?key|access[_-]?key|cookie|session)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"',
    );
  }
  return out.slice(0, MAX_LOG_MESSAGE_LENGTH);
}

/** 限制 path/message 等文本字段的长度，避免超大错误信息拖垮 D1。 */
function truncate(value: string, maxLength = 2048): string {
  return value.slice(0, maxLength);
}

/** 输出一行 JSON 并尝试持久化到 D1 events 表。 */
export async function logEvent(
  env: Env,
  event: string,
  request: Request,
  fields: LogEventFields = {},
): Promise<void> {
  const url = new URL(request.url);
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const ip = fields.ip ?? request.headers.get("CF-Connecting-IP") ?? "";
  const payload = {
    event,
    ts: Math.floor(Date.now() / 1000),
    request_id: requestId(request),
    host: fields.host ?? url.hostname,
    path: truncate(fields.path ?? url.pathname),
    method: fields.method ?? request.method,
    status: fields.status ?? 0,
    outcome: fields.outcome ?? "",
    ip_hash: await ipHash(ip, env),
    country: fields.country ?? cf?.country ?? "",
    duration_ms: fields.durationMs ?? 0,
    message: sanitizeLogMessage(fields.message ?? ""),
    account_id: fields.accountId !== undefined ? String(fields.accountId) : "",
    actor_sub: fields.actorSub ?? "",
  };

  console.log(JSON.stringify(payload));
  if (!env.DB) return;

  try {
    await ensureEventSchema(env);
    const ok = await execute(
      env.DB,
      `INSERT INTO events
        (event, ts, request_id, host, path, method, status, outcome, ip_hash, country, duration_ms, message, account_id, actor_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      payload.event,
      payload.ts,
      payload.request_id,
      payload.host,
      payload.path,
      payload.method,
      payload.status,
      payload.outcome,
      payload.ip_hash,
      payload.country,
      payload.duration_ms,
      payload.message,
      payload.account_id,
      payload.actor_sub,
    );
    if (!ok) throw new Error("D1 execute returned success=false");
  } catch (error) {
    // 事件表不可用时不能递归写错误事件，只输出到 Pages 日志。
    console.error(
      JSON.stringify({
        event: "event_store_error",
        ts: payload.ts,
        request_id: payload.request_id,
        host: payload.host,
        path: payload.path,
        method: payload.method,
        status: payload.status,
        outcome: "failed",
        message: String(error),
      }),
    );
  }
}
