-- Limooo Cloudflare Pages D1 初始 schema
-- 由 wrangler d1 execute limooo --file=./migrations/001_init.sql 执行

CREATE TABLE IF NOT EXISTS apple_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    notes       TEXT    DEFAULT '',
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocked_ips (
    cidr     TEXT PRIMARY KEY,
    note     TEXT DEFAULT '',
    added_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visitors (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ip      TEXT NOT NULL,
    country TEXT DEFAULT '',
    path    TEXT NOT NULL,
    status  INTEGER DEFAULT 0,
    ts      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_visitors_ts ON visitors (ts);
CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors (ip);
