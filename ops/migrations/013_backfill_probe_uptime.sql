-- 013 · 用历史 heartbeats 回填 probe_uptime_daily
--
-- 011 新建的按天汇总表默认是空的，不回填的话状态页在接下来 7 天里在线率全是
-- 「—」，看起来像数据丢失。MAX() 让本迁移可重复执行：实时累加已经超过回填
-- 值的天不会被改小。

INSERT INTO probe_uptime_daily (probe_id, day, total, up)
SELECT probe_id,
       ts - (ts % 86400) AS day,
       COUNT(*) AS total,
       SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS up
  FROM heartbeats
 GROUP BY probe_id, ts - (ts % 86400)
ON CONFLICT (probe_id, day) DO UPDATE SET
  total = MAX(probe_uptime_daily.total, excluded.total),
  up    = MAX(probe_uptime_daily.up, excluded.up);
