-- Limooo docs/10：封禁链路单一权威（D1 -> Cloudflare IP List）
-- 由 wrangler d1 execute limooo --file=./migrations/004_blocklist_sync.sql 执行。
-- 执行前务必先备份 D1：本迁移会把旧 blocked_ips 表重建为新结构。

DROP TABLE IF EXISTS blocked_ips_new;

CREATE TABLE IF NOT EXISTS blocked_ips_new (
    cidr        TEXT PRIMARY KEY,
    network     TEXT NOT NULL,
    prefix      INTEGER NOT NULL,
    reason      TEXT DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'auto_block',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by  TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1
);

-- 迁移旧数据：字段补全，旧记录统一视为 auto_block 来源。
INSERT OR IGNORE INTO blocked_ips_new
    (cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active)
SELECT
    c.cidr,
    CASE WHEN instr(c.cidr, '/') > 0
         THEN substr(c.cidr, 1, instr(c.cidr, '/') - 1)
         ELSE c.cidr
    END,
    CASE WHEN instr(c.cidr, '/') > 0
         THEN CAST(substr(c.cidr, instr(c.cidr, '/') + 1) AS INTEGER)
         WHEN instr(c.cidr, ':') > 0 THEN 128
         ELSE 32
    END,
    COALESCE(c.note, ''),
    'auto_block',
    COALESCE(c.added_at, datetime('now')),
    datetime('now'),
    'migration:004',
    1
FROM blocked_ips c;

DROP TABLE IF EXISTS blocked_ips;
ALTER TABLE blocked_ips_new RENAME TO blocked_ips;

CREATE INDEX IF NOT EXISTS idx_blocked_ips_network_prefix
    ON blocked_ips (network, prefix);
CREATE INDEX IF NOT EXISTS idx_blocked_ips_active
    ON blocked_ips (active, updated_at);

-- 管理 API 的审计表：解封/加封都保留操作人、时间与变更前后值。
CREATE TABLE IF NOT EXISTS blocklist_audit (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    cidr               TEXT NOT NULL,
    network            TEXT NOT NULL,
    prefix             INTEGER NOT NULL,
    action             TEXT NOT NULL,
    actor              TEXT NOT NULL DEFAULT '',
    reason             TEXT DEFAULT '',
    source             TEXT DEFAULT '',
    previous_reason    TEXT DEFAULT '',
    previous_source    TEXT DEFAULT '',
    previous_updated_at TEXT DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blocklist_audit_cidr_ts
    ON blocklist_audit (cidr, created_at);
CREATE INDEX IF NOT EXISTS idx_blocklist_audit_action_ts
    ON blocklist_audit (action, created_at);
