/**
 * GET /api/visitors/<ip_hash>/ip
 *
 * admin-only：解密**单个**访客行的完整 IP，供前端点击访客行后跳 ipinfo.io。
 *
 * 为什么单独开一个端点而不是塞进 /api/visitors 列表：
 * - 列表每次轮询最多 500 行，把 500 个密文全解一遍纯属浪费（还容易顶到
 *   Workers 免费版 10ms CPU 上限）；
 * - 完整 IP 只在用户明确要看某一行时才离开 Worker，列表响应里始终只有哈希。
 *
 * 索引：visitor_rollups 的 (ip_hash, last_ts) 索引让这次查询只读 1 行
 * （见 ops/migrations/014_visitor_ip_enc.sql）。
 */

import { queryAll } from "../../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../../_lib/session";
import { decryptVisitorIp, visitorIpKey } from "../../../_lib/visitor-ip";
import type { Env } from "../../../_lib/env";

/** ip_hash 是 HMAC-SHA256 的前 16 位十六进制（见 _lib/logging.ts ipHash）。 */
const IP_HASH_RE = /^[0-9a-f]{16}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  let session;
  try {
    session = await requireAuth(context.env, context.request);
  } catch {
    return authUnavailableResponse();
  }
  if (!session) return json({ error: "未登录" }, 401);
  if (session.role !== "admin") return json({ error: "无权限" }, 403);

  const hash = String(context.params?.hash ?? "");
  if (!IP_HASH_RE.test(hash)) return json({ error: "无效的访客标识" }, 400);

  if (!visitorIpKey(context.env)) return json({ error: "ip_unavailable" }, 503);

  const rows = await queryAll<{ ip_enc: string }>(
    context.env.DB,
    `SELECT ip_enc
       FROM visitor_rollups
      WHERE ip_hash = ? AND ip_enc != ''
      ORDER BY last_ts DESC
      LIMIT 1`,
    hash,
  );
  const token = rows[0]?.ip_enc ?? "";
  if (!token) return json({ error: "ip_unavailable" }, 404);

  const ip = await decryptVisitorIp(token, context.env);
  if (!ip) {
    console.error(JSON.stringify({ event: "visitor_ip_decrypt_error", hash }));
    return json({ error: "ip_unavailable" }, 500);
  }

  return json({ ip });
};
