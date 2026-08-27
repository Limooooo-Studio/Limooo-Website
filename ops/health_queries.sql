-- Limooo 健康检查 SQL（docs/06）
-- 由 ops/check_health.py 按 "-- name:" 块读取并逐条发送到 D1。
-- 时间窗口统一为 UTC（D1 unixepoch / datetime('now') 均使用 UTC）。

-- name: gate_verify_summary_1h
SELECT
  SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS ok,
  SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN outcome = 'unavailable' THEN 1 ELSE 0 END) AS unavailable,
  COUNT(*) AS total
FROM events
WHERE event = 'gate_verify' AND ts >= unixepoch() - 3600;

-- name: login_callback_summary_1h
SELECT
  SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
  SUM(CASE WHEN outcome IN ('bad_state', 'error') THEN 1 ELSE 0 END) AS failed,
  COUNT(*) AS total
FROM events
WHERE event = 'login_callback' AND ts >= unixepoch() - 3600;

-- name: block_match_count_1h
SELECT COUNT(*) AS count
FROM events
WHERE event = 'block_match' AND ts >= unixepoch() - 3600;

-- name: ray_request_count_1h
SELECT COUNT(*) AS count
FROM ray_log_v2
WHERE ts >= unixepoch() - 3600;

-- name: d1_write_errors_24h
SELECT COUNT(*) AS count
FROM events
WHERE event IN ('visit_record_error', 'ray_record_error')
  AND ts >= unixepoch() - 86400;

-- name: visitor_trend_1h
SELECT
  (SELECT COUNT(*) FROM visitors_v2
    WHERE ts >= unixepoch() - 3600) AS current_hour,
  (SELECT COUNT(*) FROM visitors_v2
    WHERE ts >= unixepoch() - 7200
      AND ts < unixepoch() - 3600) AS previous_hour;

-- name: ray_status_distribution_1h
SELECT status, COUNT(*) AS count
FROM ray_log_v2
WHERE ts >= unixepoch() - 3600
GROUP BY status
ORDER BY status;

-- name: visitors_daily_7d
SELECT day, SUM(requests) AS requests, SUM(unique_ips) AS unique_ips
FROM visitors_daily
WHERE day >= date('now', '-7 days')
GROUP BY day
ORDER BY day DESC
LIMIT 8;

-- name: retention_state
SELECT name, last_run_at, last_success_at, last_error
FROM retention_state
ORDER BY name;
