#!/usr/bin/env python3

"""按 Cloudflare Ray ID 直接反查 D1，供管理员终端排障。

该脚本只在 VPS 上运行，读取服务器 `secrets/webauthn.env` 中的 Cloudflare
凭据，不走公开的 `/api/ray/:id`（该接口要求登录且仅 admin）。

用法：
    RAYID=a334352fe9806564-AMS python3 ops/check_ray_id.py
  或：
    python3 ops/check_ray_id.py a334352fe9806564-AMS
"""

from __future__ import annotations

import datetime as dt
import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("LIMOOO_ROOT") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))

from ops import d1_client  # noqa: E402


def normalize_ray(raw: str) -> str:
    value = raw.split("-", 1)[0].lower()
    value = "".join(ch for ch in value if ch in "0123456789abcdef")
    if not re.fullmatch(r"[0-9a-f]{16}", value):
        raise ValueError("invalid Ray ID")
    return value


def render_row(source: str, row: dict[str, object]) -> str:
    ts = row.get("ts")
    if isinstance(ts, (int, float)):
        stamp = dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    else:
        stamp = ""
    host = row.get("host", "")
    method = row.get("method", "")
    path = row.get("path") or row.get("normalized_path") or ""
    status = row.get("status", "")
    identifier = row.get("ip_hash") or row.get("ip") or "-"
    country = row.get("country", "")
    return f"{stamp} {host} {method} {path} {status} ip={identifier} country={country} [{source}]"


def main() -> int:
    raw = os.environ.get("RAYID") or (sys.argv[1] if len(sys.argv) > 1 else "")
    try:
        ray = normalize_ray(raw)
    except ValueError:
        print("invalid Ray ID", file=sys.stderr)
        return 2

    env = d1_client.load_env(ROOT / "secrets" / "webauthn.env")
    cfg = d1_client.cloudflare_config(env)
    like = f"{ray}%"
    queries = (
        (
            "ray_log_v2",
            "SELECT ray, ts, host, normalized_path AS path, method, status, "
            "ip_hash, country FROM ray_log_v2 WHERE ray LIKE "
            f"'{like}' ORDER BY ts DESC LIMIT 100",
        ),
        (
            "ray_log",
            "SELECT ray, ts, host, path, method, status, ip, country "
            f"FROM ray_log WHERE ray LIKE '{like}' ORDER BY ts DESC LIMIT 100",
        ),
        (
            "events",
            "SELECT event, ts, request_id AS ray, host, path, method, status, "
            "outcome, ip_hash, country FROM events WHERE request_id LIKE "
            f"'{like}' ORDER BY ts DESC LIMIT 100",
        ),
    )

    found = False
    try:
        for source, sql in queries:
            rows = d1_client.d1_query(cfg, sql)
            for row in rows:
                print(render_row(source, row))
                found = True
        if not found:
            print("D1: 0 records", file=sys.stderr)
            return 1
        return 0
    except Exception as exc:  # noqa: BLE001 - 运维脚本统一收口
        print(f"D1 query failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
