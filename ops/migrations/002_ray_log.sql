-- Limooo Cloudflare Pages 侧 Ray ID 请求日志
-- 由 wrangler d1 execute limooo --file=./migrations/002_ray_log.sql 执行
-- 中间件把每次请求的 CF-Ray 连同请求信息写入此表，供 check-ray-id 按 ID 反查

CREATE TABLE IF NOT EXISTS ray_log (
    ray     TEXT PRIMARY KEY,
    ts      INTEGER DEFAULT (unixepoch()),
    host    TEXT NOT NULL,
    path    TEXT NOT NULL,
    method  TEXT NOT NULL,
    status  INTEGER DEFAULT 0,
    ip      TEXT DEFAULT '',
    country TEXT DEFAULT '',
    ua      TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ray_log_ts ON ray_log (ts);
