-- 014 · 访客行保存「可解密的 IP」（点击访客行时解密单行并跳 ipinfo.io）
--
-- 隐私约定不变：/api/visitors 列表接口仍然只返回 ip_hash；完整 IP 用独立的
-- VISITOR_IP_KEY 做 Fernet 加密后落库，只有 admin 单行查询才在 Worker 内解密。
-- 历史行（本迁移之前的记录）ip_enc 为空，无法追溯，接口会对它们返回 404。

ALTER TABLE visitor_rollups ADD COLUMN ip_enc TEXT NOT NULL DEFAULT '';

-- 单行解密按 ip_hash 精确取最近一条。visitor_rollups 的主键首列是 bucket_hour，
-- 单独按 ip_hash 查询用不上主键、会退化成扫表；补上 (ip_hash, last_ts) 索引后
-- 一次点击只读 1 行，不会碰到 D1 免费版的行读取预算。
CREATE INDEX IF NOT EXISTS idx_visitor_rollups_ip_hash
  ON visitor_rollups (ip_hash, last_ts);
