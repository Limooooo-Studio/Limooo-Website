-- Limooo D1 schema 版本登记表
-- 由 ops/migrate_d1.sh 在每次迁移后 upsert 版本号，供部署前校验使用。

CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
