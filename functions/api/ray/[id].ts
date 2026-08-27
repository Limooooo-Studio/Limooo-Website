/** GET /api/ray/:id — 仅 admin 按 Ray ID 查询最小化请求记录 */

import { queryAll } from "../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

interface RayRow {
  ray: string;
  ts: number;
  host: string;
  path: string;
  method: string;
  status: number;
  ip_hash: string;
  ua_family: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, params, request }) => {
  let session;
  try {
    session = await requireAuth(env, request);
  } catch {
    return authUnavailableResponse();
  }
  if (!session) return Response.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (session.role !== "admin") {
    return Response.json({ error: "无权限" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const id = String((params as { id?: string }).id ?? "").toLowerCase().split("-")[0];
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return Response.json({ ok: false, error: "invalid ray id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const rows = await queryAll<RayRow>(
    env.DB,
    `SELECT ray, ts, host, normalized_path AS path, method, status, ip_hash, ua_family
     FROM ray_log_v2
     WHERE ray LIKE ?
     ORDER BY ts DESC
     LIMIT 100`,
    `${id}%`,
  );
  const safeRows = rows.map(({ ray, ts, host, path, method, status, ip_hash, ua_family }) => ({
    ray, ts, host, path, method, status, ip_hash, ua_family,
  }));
  return Response.json(
    { ok: true, count: safeRows.length, rows: safeRows },
    { headers: { "Cache-Control": "no-store" } },
  );
};
