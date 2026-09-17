/**
 * D1 保留任务（从 VPS 的 ops/prune_d1.py 迁移，docs/17 阶段 6）
 *
 * VPS 退役后原 cron 不复存在，若不迁移，D1 会无限增长直至撞上单库上限。
 * 保留窗口与 prune_d1.py 的 BUCKETS 保持一致。
 *
 * 注意：prune_d1.py 还有「每小时把访客明细聚合进 visitor_rollups」的部分，
 * 本文件目前只做**每日清理**（防爆库的关键路径）；聚合迁移见 docs/18 待办。
 */

export const DAY_SECONDS = 86_400;

/** 表 → 保留秒数（与 ops/prune_d1.py 的 BUCKETS 对齐）。 */
export const BUCKETS: Record<string, number> = {
  ray_log_v2: 7 * DAY_SECONDS,
  visitors_v2: 30 * DAY_SECONDS,
  visitor_rollups: 30 * DAY_SECONDS,
  events: 90 * DAY_SECONDS,
  // 每分钟 3 条心跳 → 不清理就会无限增长，并拖慢状态页/排障查询。
  heartbeats: 30 * DAY_SECONDS,
  // 按天在线率汇总只保留 90 天（状态页最多看 7 天）。
  probe_uptime_daily: 90 * DAY_SECONDS,
};

/** 非默认时间戳列。 */
export const TIMESTAMP_COLUMNS: Record<string, string> = {
  visitor_rollups: "last_ts",
  probe_uptime_daily: "day",
};

export interface PruneResult {
  table: string;
  deleted: number;
  cutoff: number;
  error?: string;
}

/** 逐表清理过期行；任何一张表失败都不影响其它表。 */
export async function runRetention(
  env: { DB: D1Database },
  now = Math.floor(Date.now() / 1000),
): Promise<PruneResult[]> {
  const results: PruneResult[] = [];
  for (const [table, windowSeconds] of Object.entries(BUCKETS)) {
    const column = TIMESTAMP_COLUMNS[table] ?? "ts";
    const cutoff = now - windowSeconds;
    try {
      const res = await env.DB.prepare(
        `DELETE FROM ${table} WHERE ${column} < ?1`,
      )
        .bind(cutoff)
        .run();
      results.push({ table, deleted: res.meta?.changes ?? 0, cutoff });
    } catch (err) {
      results.push({ table, deleted: 0, cutoff, error: String(err).slice(0, 140) });
    }
  }
  console.log(JSON.stringify({ event: "d1_retention", results }));
  return results;
}
