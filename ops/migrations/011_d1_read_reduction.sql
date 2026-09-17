-- 011 · 降低 D1 每日行读取（2026-09-17 撞上免费版 5M 行/天上限的修复）
--
-- 实测：rows_read_24h = 7,882,267（上限 5,000,000），rows_written 24k / DB 19MB
-- 都远未超限，唯一被打爆的是「行读取」。根因是页面轮询把两个全量扫描放大了
-- 上千倍：
--   1. 访客页 60 秒轮询 /api/visitors，该接口对 30 天窗口做 4~5 趟聚合扫描；
--   2. 状态页 60 秒整页重载，每次渲染 COUNT 7 天 heartbeats（约 6 万行）。
--
-- 本迁移只做「让既有查询读得更少」的结构改动，不改语义。

-- 1) 访客统计走覆盖索引：ts 范围扫描不再回表取 ip_hash/country/status。
CREATE INDEX IF NOT EXISTS idx_visitors_v2_ts_cover
  ON visitors_v2 (ts, ip_hash, country, status);

CREATE INDEX IF NOT EXISTS idx_visitor_rollups_last_ts_cover
  ON visitor_rollups (last_ts, ip_hash, country, status);

-- 2) 探针在线率按天累加。状态页只读这一张表（每探针最多 7 行），
--    不再扫描 heartbeats。day 是「按 86400 取整的 unix 秒」，便于按数值清理。
CREATE TABLE IF NOT EXISTS probe_uptime_daily (
  probe_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (probe_id, day)
);

-- 3) heartbeats 纳入保留清理（30 天），需要 ts 单列索引才能低成本 DELETE。
CREATE INDEX IF NOT EXISTS idx_heartbeats_ts ON heartbeats (ts);
