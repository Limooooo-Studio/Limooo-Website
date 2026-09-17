-- 自建密码登录凭据（docs/17 阶段 1 替代方案 A）
-- 与 docs/09 的 auth_sessions 撤销表并存：本表只管「身份从哪来」，
-- 会话撤销与 requireAuth 的 fail-closed 语义不变。

CREATE TABLE IF NOT EXISTS auth_credentials (
    email          TEXT PRIMARY KEY,
    sub            TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'admin',   -- admin | viewer
    password_hash  TEXT NOT NULL,                   -- pbkdf2$iters$salt$hash
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until   INTEGER,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
