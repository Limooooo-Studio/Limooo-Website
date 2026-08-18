/** GET /api/visitors（需登录；D1 前向统计，无城市级信息） */

import { queryAll } from "../_lib/d1";
import { requireAuth } from "../_lib/session";
import type { Env } from "../_lib/env";

interface VisitorRow {
  ip: string;
  country: string;
  count: number;
  last_ts: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (!(await requireAuth(context.env, context.request))) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }
  const agg = await queryAll<{ ips: number; requests: number; countries: number }>(
    context.env.DB,
    `SELECT COUNT(DISTINCT ip) AS ips, COUNT(*) AS requests, COUNT(DISTINCT country) AS countries FROM visitors`,
  );
  const rows = await queryAll<VisitorRow>(
    context.env.DB,
    `SELECT v.ip,
            v.country,
            COUNT(*) AS count,
            MAX(v.ts) AS last_ts
     FROM visitors v
     GROUP BY v.ip, v.country
     ORDER BY last_ts DESC
     LIMIT 200`,
  );
  const a = agg[0] ?? { ips: 0, requests: 0, countries: 0 };
  return Response.json({
    // 兼容 visitor.html 前端的结构（原 Flask API 字段）
    stats: { total_ips: a.ips, total_requests: a.requests, countries: a.countries },
    status_counts: {},
    markers: rows.map((r) => ({
      ip: r.ip,
      country: r.country,
      city: "",
      latitude: null,
      longitude: null,
      hosts: [],
      count: r.count,
      last_time: r.last_ts,
      statuses: {},
    })),
  });
};
