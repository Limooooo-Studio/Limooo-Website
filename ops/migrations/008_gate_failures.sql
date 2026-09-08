-- 门禁失败次数：同一来源在 24 小时内第 3 次未通过时，由 Pages Function 精确封禁。
-- 只保存 HMAC 后的 IP，成功封禁后该行会立即删除。

CREATE TABLE IF NOT EXISTS gate_failures (
    ip_hash           TEXT PRIMARY KEY,
    failures          INTEGER NOT NULL DEFAULT 1,
    window_started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 访客统计压缩：同一小时/IP/页面/状态只保留一行和精确计数。
CREATE TABLE IF NOT EXISTS visitor_rollups (
    bucket_hour INTEGER NOT NULL,
    ip_hash     TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL DEFAULT '',
    status      INTEGER NOT NULL DEFAULT 0,
    page_slug   TEXT NOT NULL DEFAULT '',
    requests    INTEGER NOT NULL DEFAULT 1,
    last_ts     INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (bucket_hour, ip_hash, country, status, page_slug)
);

-- 下列索引没有生产查询使用，却会放大每条写入；主键/时间索引仍保留。
DROP INDEX IF EXISTS idx_ray_log_v2_host_ts;
DROP INDEX IF EXISTS idx_events_ip_hash_ts;
