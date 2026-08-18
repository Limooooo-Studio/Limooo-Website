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
  return Response.json({
    visitors: rows.map((r) => ({
      ip: r.ip,
      country: r.country,
      count: r.count,
      last_ts: r.last_ts,
    })),
  });
};
