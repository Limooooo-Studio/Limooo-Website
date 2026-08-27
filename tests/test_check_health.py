"""ops/check_health.py 的纯函数单元测试（无网络、无密钥访问）。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ops import check_health


class HealthScriptTests(unittest.TestCase):
    def test_load_queries_reads_named_blocks(self) -> None:
        queries = check_health.load_queries()
        self.assertIn("gate_verify_summary_1h", queries)
        self.assertIn("visitor_trend_1h", queries)
        self.assertIn("events", queries["gate_verify_summary_1h"])

    def test_evaluate_metrics_reports_expected_rates(self) -> None:
        metrics = check_health.evaluate_metrics({
            "gate_verify_summary_1h": [{
                "ok": 90,
                "failed": 9,
                "unavailable": 2,
                "total": 100,
            }],
            "login_callback_summary_1h": [{
                "ok": 95,
                "failed": 5,
                "total": 100,
            }],
            "block_match_count_1h": [{"count": 3}],
            "ray_request_count_1h": [{"count": 100}],
            "d1_write_errors_24h": [{"count": 0}],
            "visitor_trend_1h": [{
                "current_hour": 40,
                "previous_hour": 100,
            }],
            "ray_status_distribution_1h": [],
        })
        self.assertEqual(metrics["gate_verify_1h"]["failure_rate_pct"], 11.0)
        self.assertEqual(metrics["login_callback_1h"]["failure_rate_pct"], 5.0)
        self.assertEqual(metrics["block_rate_pct"], 3.0)
        self.assertEqual(metrics["visitor_drop_pct"], 60.0)
        self.assertIn("gate_failure_rate", [a["key"] for a in metrics["alerts"]])
        self.assertIn("visitor_drop", [a["key"] for a in metrics["alerts"]])

    def test_load_env_ignores_comments_and_blank_lines(self) -> None:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".env") as f:
            f.write("# comment\nEMPTY=\nKEY=value\n")
            f.flush()
            env = check_health.load_env(Path(f.name))
        self.assertEqual(env, {"EMPTY": "", "KEY": "value"})

    def test_health_log_is_valid_json_line(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            original = check_health.HEALTH_LOG
            check_health.HEALTH_LOG = Path(tmp) / "health_alerts.log"
            try:
                check_health.write_health_log({"status": "ok", "count": 1})
                line = check_health.HEALTH_LOG.read_text(encoding="utf-8").strip()
                self.assertEqual(json.loads(line)["status"], "ok")
            finally:
                check_health.HEALTH_LOG = original

    def test_build_kuma_push_url_replaces_old_query(self) -> None:
        original = (
            "https://admin.limooo.cn/api/push/secret-token"
            "?status=up&msg=ok"
        )
        result = check_health.build_kuma_push_url(
            original, "down", "query_error"
        )
        self.assertIn("/api/push/secret-token", result)
        self.assertIn("status=down", result)
        self.assertIn("msg=query_error", result)
        self.assertNotIn("msg=ok", result)


if __name__ == "__main__":
    unittest.main()
