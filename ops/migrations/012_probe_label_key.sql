-- 012 · 补齐 probes.label_key
--
-- 该列此前只在生产库上手工 ALTER 过，仓库里没有对应迁移：新环境按
-- ops/migrations/ 建库后，状态页会直接报 `no such column: p.label_key`。
-- 生产库已有该列，此迁移只对新建库生效（迁移记录见 .d1-migrations/applied）。

ALTER TABLE probes ADD COLUMN label_key TEXT;
