"""ops/check_health.py 的纯函数单元测试（无网络、无密钥访问）。"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from email import policy
from email.parser import BytesParser
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
        }, visitor_drop_enabled=True)
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

    def test_health_alert_email_has_html_and_plain_parts(self) -> None:
        metrics = check_health.evaluate_metrics({
            "gate_verify_summary_1h": [{
                "ok": 90, "failed": 9, "unavailable": 2, "total": 100,
            }],
            "login_callback_summary_1h": [{
                "ok": 95, "failed": 5, "total": 100,
            }],
            "block_match_count_1h": [{"count": 3}],
            "ray_request_count_1h": [{"count": 100}],
            "d1_write_errors_24h": [{"count": 0}],
            "visitor_trend_1h": [{
                "current_hour": 40, "previous_hour": 100,
            }],
            "ray_status_distribution_1h": [],
        }, visitor_drop_enabled=True)
        subject, plain, html = check_health.render_health_alert_email(
            {},
            metrics,
            [{"key": "visitor_drop", "message": "访客量下降 60.00%"}],
        )
        self.assertIn("[Limooo]", subject)
        self.assertIn("访客量下降", plain)
        self.assertIn("https://admin.limooo.cn", html)
        self.assertIn("关键指标", html)
        self.assertNotIn("__TITLE__", html)

    def test_visitor_drop_alert_can_be_disabled(self) -> None:
        metrics = check_health.evaluate_metrics({
            "gate_verify_summary_1h": [{
                "ok": 0, "failed": 0, "unavailable": 0, "total": 0,
            }],
            "login_callback_summary_1h": [{
                "ok": 0, "failed": 0, "total": 0,
            }],
            "block_match_count_1h": [{"count": 0}],
            "ray_request_count_1h": [{"count": 0}],
            "d1_write_errors_24h": [{"count": 0}],
            "visitor_trend_1h": [{
                "current_hour": 10, "previous_hour": 100,
            }],
            "ray_status_distribution_1h": [],
        }, visitor_drop_enabled=False)
        self.assertNotIn("visitor_drop", [a["key"] for a in metrics["alerts"]])

    def test_send_alert_builds_multipart_html_message(self) -> None:
        from email.message import EmailMessage

        message = EmailMessage()
        message["Subject"] = "test"
        message["From"] = "no-reply@limooo.cn"
        message["To"] = "lime@limooo.cn"
        message["Reply-To"] = "contact@limooo.cn"
        message.set_content("plain")
        message.add_alternative("<html><body>html</body></html>", subtype="html")

        parsed = BytesParser(policy=policy.default).parsebytes(message.as_bytes())
        self.assertEqual(parsed.get_content_type(), "multipart/alternative")
        self.assertIn("plain", parsed.get_body(preferencelist=("plain",)).get_content())
        self.assertIn(
            "html",
            parsed.get_body(preferencelist=("html",)).get_content(),
        )


class HealthRetryLoopTests(unittest.TestCase):
    """down 之后每 retry_interval 秒复查、直到恢复的节奏（纯函数，无网络）。"""

    @staticmethod
    def _ok(message: str = "healthy") -> dict:
        return {
            "status": "ok",
            "message": message,
            "metrics": {"alerts": []},
            "alerts": [],
        }

    @staticmethod
    def _down(status: str = "query_error", message: str = "boom") -> dict:
        return {"status": status, "message": message, "alerts": []}

    def _run(self, results, pushes, **kwargs):
        """用假时钟跑 run_health_loop，记录每次检查与推送的时刻。"""
        clock = [0.0]
        checks: list[float] = []
        beats: list[tuple[str, str, float]] = []
        pending_results = list(results)
        pending_pushes = list(pushes)

        def monotonic() -> float:
            return clock[0]

        def sleep(seconds: float) -> None:
            clock[0] += seconds

        def check() -> dict:
            checks.append(clock[0])
            return pending_results.pop(0)

        def push(state: str, message: str) -> str:
            beats.append((state, message, clock[0]))
            return pending_pushes.pop(0) if pending_pushes else "ok"

        summary = check_health.run_health_loop(
            check,
            push,
            monotonic=monotonic,
            sleep=sleep,
            **kwargs,
        )
        return summary, checks, beats

    def test_retries_every_interval_until_recovered(self) -> None:
        summary, checks, beats = self._run(
            [self._down(), self._down(message="boom2"), self._ok()],
            ["ok", "ok"],
            retry_interval=10,
            retry_window=280,
        )
        self.assertEqual(summary["attempts"], 3)
        self.assertTrue(summary["recovered"])
        self.assertEqual(summary["final_status"], "ok")
        self.assertEqual(checks, [0.0, 10.0, 20.0])
        # 只在 down/up 状态切换时推送，恢复当次立刻推 up。
        self.assertEqual([beat[0] for beat in beats], ["down", "up"])
        self.assertEqual(beats[1][2], 20.0)
        self.assertEqual(beats[0][1], "boom")

    def test_stops_when_window_expires_still_down(self) -> None:
        summary, checks, beats = self._run(
            [self._down() for _ in range(10)],
            ["ok"],
            retry_interval=10,
            retry_window=25,
        )
        self.assertEqual(summary["attempts"], 3)
        self.assertEqual(checks, [0.0, 10.0, 20.0])
        self.assertFalse(summary["recovered"])
        self.assertEqual(summary["final_status"], "query_error")
        self.assertEqual(len(beats), 1)

    def test_retries_failed_push_without_repeating_down_beats(self) -> None:
        summary, _checks, beats = self._run(
            [self._ok(), self._ok()],
            ["failed", "ok"],
            retry_interval=10,
            retry_window=280,
        )
        self.assertEqual(summary["attempts"], 2)
        self.assertTrue(summary["recovered"])
        self.assertEqual([beat[0] for beat in beats], ["up", "up"])
        self.assertEqual([beat[2] for beat in beats], [0.0, 10.0])

    def test_single_attempt_when_retry_window_disabled(self) -> None:
        summary, checks, beats = self._run(
            [self._down()],
            ["ok"],
            retry_interval=10,
            retry_window=0,
        )
        self.assertEqual(summary["attempts"], 1)
        self.assertEqual(checks, [0.0])
        self.assertFalse(summary["recovered"])
        self.assertEqual([beat[0] for beat in beats], ["down"])

    def test_missing_push_url_does_not_block_recovery(self) -> None:
        summary, _checks, beats = self._run(
            [self._down(), self._ok()],
            ["skipped", "skipped"],
            retry_interval=10,
            retry_window=280,
        )
        self.assertTrue(summary["recovered"])
        self.assertEqual([beat[0] for beat in beats], ["down", "up"])

    def test_alert_result_keeps_first_threshold_breach(self) -> None:
        breach = {
            "status": "alert",
            "message": "门禁验证失败率 20.00%",
            "metrics": {"alerts": [{"key": "gate_failure_rate"}]},
            "alerts": [{"key": "gate_failure_rate", "message": "门禁验证失败率 20.00%"}],
        }
        summary, _checks, _beats = self._run(
            [breach, self._ok()],
            ["ok", "ok"],
            retry_interval=10,
            retry_window=280,
        )
        self.assertTrue(summary["recovered"])
        self.assertEqual(summary["alert_result"], breach)
        self.assertEqual(summary["first_down"], breach)

    def test_perform_check_reports_config_error_without_network(self) -> None:
        result = check_health.perform_check(
            {"token": "", "account_id": "", "database_id": ""}
        )
        self.assertEqual(result["status"], "config_error")
        self.assertEqual(result["alerts"], [])

    def test_single_instance_lock_blocks_second_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            original_lock = check_health.LOCK_FILE
            check_health.LOCK_FILE = Path(tmp) / "health_check.lock"
            try:
                self.assertTrue(check_health.acquire_lock())
                # 第二个实例必须让路，不能与复查循环并跑
                self.assertFalse(check_health.acquire_lock())
                self.assertEqual(
                    check_health.LOCK_FILE.read_text(encoding="utf-8"),
                    str(os.getpid()),
                )
            finally:
                check_health.LOCK_FILE = original_lock
                handle = check_health._LOCK_HANDLE
                check_health._LOCK_HANDLE = None
                if handle is not None:
                    handle.close()


if __name__ == "__main__":
    unittest.main()
