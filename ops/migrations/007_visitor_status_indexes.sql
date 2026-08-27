-- Limooo D1 访客状态筛选索引（docs/15）
--
-- /api/visitors 保留 ?status=<3位数字> 兼容入口；为按状态筛选时避免全表扫描，
-- 为 visitors_v2 增加 (status, ts) 与 (status, ip_hash, ts) 两个复合索引。
-- 只增量添加索引，不删除已有索引；重复执行保持幂等。

CREATE INDEX IF NOT EXISTS idx_visitors_v2_status_ts
    ON visitors_v2 (status, ts);

CREATE INDEX IF NOT EXISTS idx_visitors_v2_status_ip_hash_ts
    ON visitors_v2 (status, ip_hash, ts);
