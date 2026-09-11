"""ops/prune_d1.py 的纯函数测试（不连接 Cloudflare，不访问密钥）。"""

from __future__ import annotations

from ops import prune_d1


def test_retention_buckets_are_7_30_90_days() -> None:
    assert prune_d1.BUCKETS["ray_log_v2"] == 7 * 86400
    assert prune_d1.BUCKETS["visitors_v2"] == 30 * 86400
    assert prune_d1.BUCKETS["visitor_rollups"] == 30 * 86400
    assert prune_d1.BUCKETS["events"] == 90 * 86400


def test_aggregate_sql_targets_v2_and_daily() -> None:
    sql = prune_d1._aggregate_sql()
    assert "FROM visitors_v2" in sql
    assert "FROM visitor_rollups" in sql
    assert "INSERT OR REPLACE INTO visitors_daily" in sql
    assert "ip_hash" in sql


def test_aggregate_daily_does_not_count_entire_daily_table(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(prune_d1, "d1_query", lambda cfg, sql: calls.append(sql) or [])
    monkeypatch.setattr(prune_d1, "_write_retention_state", lambda *args, **kwargs: None)

    assert prune_d1.aggregate_daily({"token": "t", "account_id": "a", "database_id": "d"}) == {
        "visitors_daily": "updated"
    }
    assert not any("COUNT(*) AS count FROM visitors_daily" in sql for sql in calls)


def test_prune_uses_rollup_last_ts_column(monkeypatch) -> None:
    calls: list[str] = []

    def fake_query(cfg, sql: str):
        calls.append(sql)
        return [{"count": 0}] if sql.startswith("SELECT COUNT") else []

    monkeypatch.setattr(prune_d1, "d1_query", fake_query)
    monkeypatch.setattr(prune_d1, "_write_retention_state", lambda *args, **kwargs: None)

    prune_d1.prune_buckets({"token": "t", "account_id": "a", "database_id": "d"})

    rollup_calls = [sql for sql in calls if "visitor_rollups" in sql]
    assert any("WHERE last_ts <" in sql for sql in rollup_calls)
    assert not any("visitor_rollups WHERE ts" in sql for sql in rollup_calls)


def test_dry_run_uses_rollup_last_ts_column(monkeypatch) -> None:
    calls: list[str] = []

    def fake_query(cfg, sql: str):
        calls.append(sql)
        return [{"count": 0}]

    monkeypatch.setattr(prune_d1, "d1_query", fake_query)

    prune_d1.dry_run({"token": "t", "account_id": "a", "database_id": "d"}, "prune")

    assert any("visitor_rollups" in sql and "WHERE last_ts <" in sql for sql in calls)


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
    assert plan["buckets"]["visitor_rollups"] == 3
    assert plan["buckets"]["events"] == 3
    assert plan["aggregate_rows"] == 3
    assert any("DELETE" not in sql for sql in calls)
