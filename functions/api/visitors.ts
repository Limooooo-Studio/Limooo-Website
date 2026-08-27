/**
 * GET /api/visitors
 *
 * 需要 admin 会话，D1 前向统计。为保护隐私，接口不返回完整 IP，只返回
 * ip_hash。前端状态筛选已本地化，因此主前端只调用不带 status 参数的端点；
 * `?status=<3位数字>` 保留给深链和外部调用。
 *
 * 查询范围：visitors_v2 默认只统计最近 30 天（与 docs/11 保留期一致），
 * 避免表增长后每次刷新都做全表聚合。本实现把“全局统计 + 状态分布”合并为
 * 一条查询，把“IP 列表 + 每个 IP 的状态分布”合并为另一条查询。
 */

import { queryAll } from "../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../_lib/session";
import type { Env } from "../_lib/env";

const VISITOR_WINDOW_DAYS = 30;
const VISITOR_WINDOW_SECONDS = VISITOR_WINDOW_DAYS * 24 * 60 * 60;
const MAX_VISITOR_MARKERS = 500;

interface StatsRow {
  ips: number;
  requests: number;
  countries: number;
  status_series: string | null;
}

interface MarkerRow {
  ip_hash: string;
  country: string;
  status: number;
  n: number;
  last_ts: string;
}

interface MarkerAccumulator {
  country: string;
  count: number;
  last_time: string;
  statuses: Record<string, number>;
}

function parseStatusSeries(value: string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!value) return counts;
  for (const part of value.split(",")) {
    const sep = part.lastIndexOf(":");
    if (sep <= 0) continue;
    const code = part.slice(0, sep).trim();
    const n = Number(part.slice(sep + 1));
    if (code && Number.isFinite(n)) {
      counts[code] = (counts[code] ?? 0) + n;
    }
  }
  return counts;
}

function buildMarkers(rows: MarkerRow[]): Array<{
  ip: null;
  ip_hash: string;
  country: string;
  city: string;
  latitude: null;
  longitude: null;
  hosts: unknown[];
  count: number;
  last_time: string;
  statuses: Record<string, number>;
}> {
  const byHash = new Map<string, MarkerAccumulator>();
  for (const row of rows) {
    let acc = byHash.get(row.ip_hash);
    if (!acc) {
      acc = {
        country: row.country,
        count: 0,
        last_time: row.last_ts,
        statuses: {},
      };
      byHash.set(row.ip_hash, acc);
    }
    acc.count += row.n;
    if (row.last_ts > acc.last_time) acc.last_time = row.last_ts;
    const key = String(row.status);
    acc.statuses[key] = (acc.statuses[key] ?? 0) + row.n;
  }

  return Array.from(byHash.entries(), ([ip_hash, acc]) => ({
    ip: null,
    ip_hash,
    country: acc.country,
    city: "",
    latitude: null,
    longitude: null,
    hosts: [],
    count: acc.count,
    last_time: acc.last_time,
    statuses: acc.statuses,
  }));
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  let session;
  try {
    session = await requireAuth(context.env, context.request);
  } catch {
    return authUnavailableResponse();
  }
  if (!session) {
    return Response.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (session.role !== "admin") {
    return Response.json({ error: "无权限" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const url = new URL(context.request.url);
  const statusParam = url.searchParams.get("status");
  if (statusParam !== null && !/^\d{3}$/.test(statusParam)) {
    return Response.json(
      { error: "无效的 status 参数，应为三位数字" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const statusNum = statusParam === null ? null : Number(statusParam);
  const cutoff = Math.floor(Date.now() / 1000) - VISITOR_WINDOW_SECONDS;

  // 查询 1：全局统计 + 全量状态分布。用同一 30 天窗口，避免状态分布与
  // 顶部统计口径不一致。
  const statsRows = await queryAll<StatsRow>(
    context.env.DB,
    `WITH scoped AS (
        SELECT ip_hash, country, status, ts
        FROM visitors_v2
        WHERE ts >= ?
     )
     SELECT
       (SELECT COUNT(DISTINCT ip_hash) FROM scoped) AS ips,
       (SELECT COUNT(*) FROM scoped) AS requests,
       (SELECT COUNT(DISTINCT country) FROM scoped) AS countries,
       (SELECT GROUP_CONCAT(status || ':' || n, ',') FROM (
          SELECT status, COUNT(*) AS n FROM scoped GROUP BY status ORDER BY status
       )) AS status_series`,
    cutoff,
  );

  // 查询 2：最近 500 个 IP 哈希的列表及每个 IP 的状态分布。
  // 先取 top 500，再按 ip_hash+status 分组，一次拿到构建 markers 所需的全部行。
  const markerSql = statusNum === null
    ? `WITH scoped AS (
         SELECT ip_hash, country, status, ts
         FROM visitors_v2
         WHERE ts >= ?
       ),
       top AS (
         SELECT ip_hash, MAX(ts) AS last_ts
         FROM scoped
         GROUP BY ip_hash
         ORDER BY last_ts DESC
         LIMIT ${MAX_VISITOR_MARKERS}
       )
       SELECT v.ip_hash,
              MAX(v.country) AS country,
              v.status,
              COUNT(*) AS n,
              strftime('%Y-%m-%d %H:%M:%S', MAX(v.ts), 'unixepoch') AS last_ts
       FROM scoped v
       JOIN top t ON t.ip_hash = v.ip_hash
       GROUP BY v.ip_hash, v.status
       ORDER BY MAX(v.ts) DESC, v.status`
    : `WITH scoped AS (
         SELECT ip_hash, country, status, ts
         FROM visitors_v2
         WHERE ts >= ? AND status = ?
       ),
       top AS (
         SELECT ip_hash, MAX(ts) AS last_ts
         FROM scoped
         GROUP BY ip_hash
         ORDER BY last_ts DESC
         LIMIT ${MAX_VISITOR_MARKERS}
       )
       SELECT v.ip_hash,
              MAX(v.country) AS country,
              v.status,
              COUNT(*) AS n,
              strftime('%Y-%m-%d %H:%M:%S', MAX(v.ts), 'unixepoch') AS last_ts
       FROM scoped v
       JOIN top t ON t.ip_hash = v.ip_hash
       GROUP BY v.ip_hash, v.status
       ORDER BY MAX(v.ts) DESC, v.status`;

  const markerParams: unknown[] = statusNum === null ? [cutoff] : [cutoff, statusNum];
  const markerRows = await queryAll<MarkerRow>(context.env.DB, markerSql, ...markerParams);

  const stats = statsRows[0] ?? { ips: 0, requests: 0, countries: 0, status_series: null };
  const statusCounts = parseStatusSeries(stats.status_series);

  return Response.json(
    {
      stats: { total_ips: stats.ips, total_requests: stats.requests, countries: stats.countries },
      status_counts: statusCounts,
      range_days: VISITOR_WINDOW_DAYS,
      max_markers: MAX_VISITOR_MARKERS,
      markers: buildMarkers(markerRows),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
