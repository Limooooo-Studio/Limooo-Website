-- Limooo D1 审计字段（docs/08）
-- 针对已部署的 events 表增量补充 reveal 审计所需字段；
-- 新环境由 functions/_lib/logging.ts 的 CREATE TABLE IF NOT EXISTS 直接创建，
-- 此迁移仅用于已有 events 表的升级。

ALTER TABLE events ADD COLUMN account_id TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN actor_sub TEXT DEFAULT '';
