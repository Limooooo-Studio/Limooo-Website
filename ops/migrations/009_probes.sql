-- 探针与心跳：取代 Uptime Kuma（docs/17 阶段 2）
--
-- 数据模型对应原 Kuma 的 monitor / heartbeat，但收敛为最小集合：
--   probes         探针定义（替代 Kuma monitor 表）
--   heartbeats     每次探测结果（替代 Kuma heartbeat 表）
--   probe_state    当前状态与连续失败计数（供 10 秒复查与告警判定）
--
-- 保留策略：heartbeats 按需由 prune_d1 聚合/清理（见 ops/prune_d1.py）。

CREATE TABLE IF NOT EXISTS probes (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL DEFAULT 'http',   -- http | d1
    target       TEXT,                              -- http 探针的目标 URL
    group_key    TEXT    NOT NULL DEFAULT 'internal', -- public | internal
    interval_s   INTEGER NOT NULL DEFAULT 60,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS heartbeats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    probe_id   INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    status     INTEGER NOT NULL,          -- 1 up / 0 down / 2 pending
    latency_ms INTEGER,
    msg        TEXT
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_probe_ts
    ON heartbeats (probe_id, ts DESC);

CREATE TABLE IF NOT EXISTS probe_state (
    probe_id         INTEGER PRIMARY KEY,
    last_status      INTEGER,
    consecutive_fail INTEGER NOT NULL DEFAULT 0,
    down_since       INTEGER,
    checked_at       INTEGER
);

-- 种子数据：对应 docs/17 §1.3 实测的 Kuma 监控项（去掉重复条目）
--
-- 注意：id=2 原先探的是 `admin.limooo.cn/_health`（authentik + Kuma 时代）。
-- VPS 退租后该域名已无 DNS 记录，探针每分钟固定拿到 http_530，状态页永远显示
-- 一项 down——这是过时配置，不是真实故障。改为探同区域的静态资源主机：
-- 不能探 Worker 自己的域名（对自身 zone 的 subrequest 会被 Cloudflare 拦掉）。
-- 已有库请用 015 迁移同步（INSERT OR IGNORE 不会更新已存在的行）。
INSERT OR IGNORE INTO probes (id, name, type, target, group_key, interval_s) VALUES
    (1, 'Website',      'http', 'https://limooo.cn/_health',         'public',   60),
    (2, 'Edge Assets',  'http', 'https://images.limooo.cn/_health',  'internal', 60),
    (3, 'D1 Health',    'd1',   NULL,                                'internal', 900);
