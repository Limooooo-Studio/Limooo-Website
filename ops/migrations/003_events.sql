-- Limooo 可观测性：统一事件表（docs/06）
-- 由 wrangler d1 execute limooo --file=./migrations/003_events.sql 执行；
-- 健康检查脚本首次运行时也会通过 D1 API 幂等创建同名表。

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT    NOT NULL,
    ts          INTEGER NOT NULL DEFAULT (unixepoch()),
    request_id  TEXT    DEFAULT '',
    host        TEXT    DEFAULT '',
    path        TEXT    DEFAULT '',
    method      TEXT    DEFAULT '',
    status      INTEGER DEFAULT 0,
    outcome     TEXT    DEFAULT '',
    ip_hash     TEXT    DEFAULT '',
    country     TEXT    DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    message     TEXT    DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_events_ts_event ON events (ts, event);
CREATE INDEX IF NOT EXISTS idx_events_event_outcome_ts ON events (event, outcome, ts);
CREATE INDEX IF NOT EXISTS idx_events_request_id ON events (request_id);
