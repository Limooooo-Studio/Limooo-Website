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
  const url = new URL(context.request.url);
  const statusParam = url.searchParams.get("status");
  const statusNum = statusParam && /^\d{3}$/.test(statusParam) ? Number(statusParam) : null;

  // 全量聚合与状态码分布（不随筛选变化）
  const agg = await queryAll<{ ips: number; requests: number; countries: number }>(
    context.env.DB,
    `SELECT COUNT(DISTINCT ip) AS ips, COUNT(*) AS requests, COUNT(DISTINCT country) AS countries FROM visitors`,
  );
  const scRows = await queryAll<{ status: number; n: number }>(
    context.env.DB,
    `SELECT status, COUNT(*) AS n FROM visitors GROUP BY status ORDER BY status`,
  );

  // IP 列表（可按状态码过滤）
  const rows = await queryAll<VisitorRow>(
    context.env.DB,
    statusNum === null
      ? `SELECT v.ip,
            v.country,
            COUNT(*) AS count,
            MAX(v.ts) AS last_ts
     FROM visitors v
     GROUP BY v.ip, v.country
     ORDER BY last_ts DESC
     LIMIT 500`
      : `SELECT v.ip,
            v.country,
            COUNT(*) AS count,
            MAX(v.ts) AS last_ts
     FROM visitors v
     WHERE v.status = ?
     GROUP BY v.ip, v.country
     ORDER BY last_ts DESC
     LIMIT 500`,
    ...(statusNum === null ? [] : [statusNum]),
  );

  // 每个 IP 的状态码分布（与列表同一筛选范围）
  const stRows = await queryAll<{ ip: string; status: number; n: number }>(
    context.env.DB,
    statusNum === null
      ? `SELECT ip, status, COUNT(*) AS n FROM visitors GROUP BY ip, status`
      : `SELECT ip, status, COUNT(*) AS n FROM visitors WHERE status = ? GROUP BY ip, status`,
    ...(statusNum === null ? [] : [statusNum]),
  );
  const statusesByIp = new Map<string, Record<string, number>>();
  for (const r of stRows) {
    const cur = statusesByIp.get(r.ip) ?? {};
    cur[String(r.status)] = r.n;
    statusesByIp.set(r.ip, cur);
  }

  const a = agg[0] ?? { ips: 0, requests: 0, countries: 0 };
  const statusCounts: Record<string, number> = {};
  for (const r of scRows) statusCounts[String(r.status)] = r.n;
  return Response.json({
    // 兼容 visitor.html 前端的结构（原 Flask API 字段）
    stats: { total_ips: a.ips, total_requests: a.requests, countries: a.countries },
    status_counts: statusCounts,
    markers: rows.map((r) => ({
      ip: r.ip,
      country: r.country,
      city: "",
      latitude: null,
      longitude: null,
      hosts: [],
      count: r.count,
      last_time: r.last_ts,
      statuses: statusesByIp.get(r.ip) ?? {},
    })),
  });
};
