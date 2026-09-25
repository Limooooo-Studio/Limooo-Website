-- 015 · 修正探针 2 的失效目标（VPS 退租残留）
--
-- 背景：id=2 的探针原指向 `https://admin.limooo.cn/_health`。该域名是 authentik +
-- Uptime Kuma 时代的运维入口，随 VPS 一起退租后已无 DNS 记录（解析失败 / http_530）。
-- 探针每分钟照跑，于是状态页长期显示一项 down——那是过时配置，不是真实故障。
--
-- 009_probes.sql 用的是 INSERT OR IGNORE，改种子不会影响已建库，故单独补一条
-- 幂等迁移；同时把三项的 label_key 补齐，让状态页卡片名跟随界面语言。
--
-- 只对「仍是旧值」的行生效，避免覆盖运维手工调整过的目标。

-- 注：不能探 `status.limooo.cn/_health` 或 Workers 自带的 `*.workers.dev` 域名——
-- Worker 对「自己所在 zone / 自己的路由」发起的 subrequest 会被 Cloudflare 拦掉
-- （实测分别得到 http_522 / http_404，而外部 curl 同一 URL 是 200）。因此改探
-- 同区域的静态资源主机，既真实可达，又确实覆盖「边缘资产是否正常」。
UPDATE probes
   SET target = 'https://images.limooo.cn/_health',
       name   = 'Edge Assets'
 WHERE id = 2
   AND (target = 'https://admin.limooo.cn/_health' OR target IS NULL);

UPDATE probes SET label_key = 'card_website' WHERE id = 1 AND label_key IS NULL;
-- `card_admin` 已从 status-worker 的文案表移除（管理入口随 VPS 消失），指向它的
-- 旧标签会退回显示英文 name，故一并改到新的 card_status。
UPDATE probes SET label_key = 'card_status'  WHERE id = 2 AND (label_key IS NULL OR label_key = 'card_admin');
UPDATE probes SET label_key = 'card_d1'      WHERE id = 3 AND label_key IS NULL;
