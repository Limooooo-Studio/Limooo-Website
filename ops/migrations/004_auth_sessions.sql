-- Limooo Pages OIDC 会话撤销表（docs/09）
-- 并行代理已占用 004_* 迁移前缀，本文件使用约定名称以接入 migrate_d1.sh。
-- 由 wrangler d1 execute limooo --file=./migrations/004_auth_sessions.sql 执行；
-- 表不存在时 requireAuth 必须返回 503，不能仅凭签名 cookie 放行。

CREATE TABLE IF NOT EXISTS auth_sessions (
    sid         TEXT PRIMARY KEY,
    sub         TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    auth_at     INTEGER NOT NULL,
    exp         INTEGER NOT NULL,
    revoked_at  INTEGER DEFAULT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_sub_exp ON auth_sessions (sub, exp);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked_at ON auth_sessions (revoked_at);
