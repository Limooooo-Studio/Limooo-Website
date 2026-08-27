#!/usr/bin/env python3

"""Limooo D1 保留期与每日聚合脚本（docs/11）。

默认只做 dry-run，不删除任何数据；只有显式传入 --apply 才执行聚合与清理。
运行方式（示例，均为生产动作，执行前需在 docs/parallel-actions.md 登记）：

    python3 ops/prune_d1.py --mode all          # 只读：统计与计划
    python3 ops/prune_d1.py --mode aggregate --apply   # 聚合 visitors_daily
    python3 ops/prune_d1.py --mode prune --apply       # 清理 7/30/90 天旧数据

保留期：
    ray_log_v2  7 天
    visitors_v2 30 天
    events      90 天
    visitors_daily 永久
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ops"))
sys.path.insert(0, str(ROOT / "src"))

from config import ENV_FILE  # noqa: E402

from d1_client import cloudflare_config, d1_query, load_env  # noqa: E402
from check_health import ensure_schema  # noqa: E402

DAY_SECONDS = 86400
BUCKETS: dict[str, int] = {
    "ray_log_v2": 7 * DAY_SECONDS,
    "visitors_v2": 30 * DAY_SECONDS,
    "events": 90 * DAY_SECONDS,
}
AGGREGATE_WINDOW_SECONDS = DAY_SECONDS


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _count_rows(cfg: dict[str, str], table: str, cutoff: int) -> int:
    rows = d1_query(
        cfg,
        f"SELECT COUNT(*) AS count FROM {table} WHERE ts < {cutoff}",
    )
    return int(rows[0].get("count") or 0) if rows else 0


def _aggregate_sql() -> str:
    """把最近一天的新 visitors_v2 汇入 visitors_daily（可重复执行）。"""
    return (
        "INSERT OR REPLACE INTO visitors_daily "
        "(day, country, page_slug, status, unique_ips, requests) "
        "SELECT strftime('%Y-%m-%d', ts, 'unixepoch'), country, page_slug, status, "
        "COUNT(DISTINCT CASE WHEN ip_hash <> '' THEN ip_hash ELSE id END), COUNT(*) "
        "FROM visitors_v2 "
        f"WHERE ts >= unixepoch() - {AGGREGATE_WINDOW_SECONDS} "
        "GROUP BY strftime('%Y-%m-%d', ts, 'unixepoch'), country, page_slug, status"
    )


def _aggregate_count_sql() -> str:
    return (
        "SELECT COUNT(*) AS count FROM ("
        "SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS day, "
        "country, page_slug, status, COUNT(*) AS n "
        "FROM visitors_v2 "
        f"WHERE ts >= unixepoch() - {AGGREGATE_WINDOW_SECONDS} "
        "GROUP BY day, country, page_slug, status)"
    )


def _write_retention_state(
    cfg: dict[str, str],
    name: str,
    *,
    success: bool,
    deleted: int = 0,
    error: str = "",
) -> None:
    message = f"bucket={name};deleted={deleted}" if success else f"bucket={name};error={error}"
    now = "unixepoch()"
    state = (
        "INSERT OR REPLACE INTO retention_state "
        "(name, last_run_at, last_success_at, last_error) "
        f"VALUES ({_quote(name)}, {now}, "
        f"{now if success else 0}, {_quote(error)})"
    )
    d1_query(cfg, state)
    event = (
        "INSERT INTO events "
        "(event, ts, request_id, host, path, method, status, outcome, ip_hash, "
        "country, duration_ms, message) "
        f"VALUES ('prune_result', {now}, '', 'ops', '/retention', 'run', "
        f"{200 if success else 500}, '{'ok' if success else 'failed'}', '', '', 0, "
        f"{_quote(message)})"
    )
    d1_query(cfg, event)


def aggregate_daily(cfg: dict[str, str]) -> dict[str, Any]:
    """从 visitors_v2 增量聚合到 visitors_daily。"""
    d1_query(cfg, _aggregate_sql())
    rows = d1_query(cfg, "SELECT COUNT(*) AS count FROM visitors_daily")
    count = int(rows[0].get("count") or 0) if rows else 0
    _write_retention_state(cfg, "visitors_daily", success=True)
    return {"visitors_daily_rows": count}


def prune_buckets(cfg: dict[str, str]) -> dict[str, Any]:
    """按保留期清理 v2 表与 events，并记录 retention_state。"""
    result: dict[str, int] = {}
    now = "unixepoch()"
    for table, seconds in BUCKETS.items():
        cutoff_expr = f"{now} - {seconds}"
        rows = d1_query(cfg, f"SELECT COUNT(*) AS count FROM {table} WHERE ts < {cutoff_expr}")
        count = int(rows[0].get("count") or 0) if rows else 0
        d1_query(cfg, f"DELETE FROM {table} WHERE ts < {cutoff_expr}")
        _write_retention_state(cfg, table, success=True, deleted=count)
        result[table] = count
    return result


def dry_run(cfg: dict[str, str], mode: str) -> dict[str, Any]:
    """只读统计：不建表、不写状态、不删除。"""
    plan: dict[str, Any] = {"mode": mode, "buckets": {}}
    if mode in ("all", "prune"):
        for table, seconds in BUCKETS.items():
            rows = d1_query(
                cfg,
                f"SELECT COUNT(*) AS count FROM {table} WHERE ts < unixepoch() - {seconds}",
            )
            plan["buckets"][table] = int(rows[0].get("count") or 0) if rows else 0
    if mode in ("all", "aggregate"):
        rows = d1_query(cfg, _aggregate_count_sql())
        plan["aggregate_rows"] = int(rows[0].get("count") or 0) if rows else 0
    return plan


def main() -> int:
    parser = argparse.ArgumentParser(description="D1 保留期与每日聚合")
    parser.add_argument(
        "--mode",
        choices=("all", "aggregate", "prune"),
        default="all",
        help="all=聚合+清理；aggregate=只聚合；prune=只清理",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="执行真实写入/删除；不传时始终 dry-run。",
    )
    args = parser.parse_args()

    try:
        env = load_env(ENV_FILE)
        cfg = cloudflare_config(env)
        if not cfg["token"] or not cfg["account_id"] or not cfg["database_id"]:
            raise RuntimeError("Cloudflare / D1 配置缺失")
        if args.apply:
            ensure_schema(cfg)
            if args.mode in ("all", "aggregate"):
                print(json.dumps(aggregate_daily(cfg), ensure_ascii=False, indent=2))
            if args.mode in ("all", "prune"):
                print(json.dumps(prune_buckets(cfg), ensure_ascii=False, indent=2))
        else:
            print(
                json.dumps(
                    {"dry_run": True, **dry_run(cfg, args.mode)},
                    ensure_ascii=False,
                    indent=2,
                )
            )
            print("提示：未传 --apply，未执行任何写入/删除。")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
