"""ops/prune_d1.py 的纯函数测试（不连接 Cloudflare，不访问密钥）。"""

from __future__ import annotations

from ops import prune_d1


def test_retention_buckets_are_7_30_90_days() -> None:
    assert prune_d1.BUCKETS["ray_log_v2"] == 7 * 86400
    assert prune_d1.BUCKETS["visitors_v2"] == 30 * 86400
    assert prune_d1.BUCKETS["events"] == 90 * 86400


def test_aggregate_sql_targets_v2_and_daily() -> None:
    sql = prune_d1._aggregate_sql()
    assert "FROM visitors_v2" in sql
    assert "INSERT OR REPLACE INTO visitors_daily" in sql
    assert "ip_hash" in sql


def test_dry_run_reports_counts_without_deleting(monkeypatch) -> None:
    calls: list[str] = []

    def fake_query(cfg, sql: str):
        calls.append(sql)
        if "FROM visitors_daily" in sql or "SELECT COUNT(*) AS count" in sql:
            return [{"count": 3}]
        return []

    monkeypatch.setattr(prune_d1, "d1_query", fake_query)
    plan = prune_d1.dry_run({"token": "t", "account_id": "a", "database_id": "d"}, "all")
    assert plan["buckets"]["ray_log_v2"] == 3
    assert plan["buckets"]["visitors_v2"] == 3
    assert plan["buckets"]["events"] == 3
    assert plan["aggregate_rows"] == 3
    assert any("DELETE" not in sql for sql in calls)
