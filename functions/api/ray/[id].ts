/** GET /api/ray/:id — 按 Ray ID 查询 Pages 侧请求记录（check-ray-id 本地工具调用） */

import { queryAll } from "../../_lib/d1";
import type { Env } from "../../_lib/env";

interface RayRow {
  ray: string;
  ts: number;
  host: string;
  path: string;
  method: string;
  status: number;
  ip: string;
  country: string;
  ua: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = String((params as { id?: string }).id ?? "").toLowerCase().split("-")[0];
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return Response.json({ ok: false, error: "invalid ray id" }, { status: 400 });
  }
  const rows = await queryAll<RayRow>(
    env.DB,
    `SELECT ray, ts, host, path, method, status, ip, country, ua
     FROM ray_log
     WHERE ray LIKE ?
     ORDER BY ts DESC
     LIMIT 100`,
    `${id}%`,
  );
  return Response.json({ ok: true, count: rows.length, rows });
};
