-- Limooo D1 数据保留与隐私（docs/11）
--
-- 该迁移创建不保存完整 IP / UA / query 的 v2 表；旧 visitors / ray_log
-- 作为历史只读数据保留，后续由 ops/prune_d1.py 按保留期独立处理。

CREATE TABLE IF NOT EXISTS visitors_v2 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash     TEXT    NOT NULL DEFAULT '',
    country     TEXT    NOT NULL DEFAULT '',
    status      INTEGER NOT NULL DEFAULT 0,
    ts          INTEGER NOT NULL DEFAULT (unixepoch()),
    page_slug   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_visitors_v2_ts ON visitors_v2 (ts);
CREATE INDEX IF NOT EXISTS idx_visitors_v2_ip_hash_ts ON visitors_v2 (ip_hash, ts);
CREATE INDEX IF NOT EXISTS idx_visitors_v2_page_slug_ts ON visitors_v2 (page_slug, ts);

CREATE TABLE IF NOT EXISTS ray_log_v2 (
    ray             TEXT    PRIMARY KEY,
    ts              INTEGER NOT NULL DEFAULT (unixepoch()),
    host            TEXT    NOT NULL DEFAULT '',
    normalized_path TEXT    NOT NULL DEFAULT '',
    method          TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    ip_hash         TEXT    NOT NULL DEFAULT '',
    country         TEXT    NOT NULL DEFAULT '',
    ua_family       TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ray_log_v2_ts ON ray_log_v2 (ts);
CREATE INDEX IF NOT EXISTS idx_ray_log_v2_host_ts ON ray_log_v2 (host, ts);

-- 长期聚合表：保留期永久；唯一键按 UTC 天 + 维度。
CREATE TABLE IF NOT EXISTS visitors_daily (
    day         TEXT NOT NULL,
    country     TEXT NOT NULL DEFAULT '',
    page_slug   TEXT NOT NULL DEFAULT '',
    status      INTEGER NOT NULL DEFAULT 0,
    unique_ips  INTEGER NOT NULL DEFAULT 0,
    requests    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, country, page_slug, status)
);

CREATE INDEX IF NOT EXISTS idx_visitors_daily_day ON visitors_daily (day);

-- 清理/聚合任务状态：用于告警与失败追踪，不保存任何敏感值。
CREATE TABLE IF NOT EXISTS retention_state (
    name             TEXT PRIMARY KEY,
    last_run_at      INTEGER NOT NULL DEFAULT 0,
    last_success_at  INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT NOT NULL DEFAULT ''
);

-- events 增加按 ip_hash + ts 的聚合索引（同 003 的字段，不改字段契约）。
CREATE INDEX IF NOT EXISTS idx_events_ip_hash_ts ON events (ip_hash, ts);
