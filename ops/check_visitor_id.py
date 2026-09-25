#!/usr/bin/env python3

"""按访客 ID（ip_hash）反查该访客的真实 IP 与访问概况，供管理员终端排障。

访客页每行显示的 `ID: xxxxxxxxxxxxxxxx` 就是 `visitor_rollups.ip_hash`
（HMAC-SHA256 前 16 位）。完整 IP 从 2026-09-26 起以 Fernet 密文存在
`visitor_rollups.ip_enc`，密钥是本机 secrets/webauthn.env 里的 VISITOR_IP_KEY
（与 Worker `functions/_lib/visitor-ip.ts` 用的是同一把，互相可解）。

数据源：D1 `visitor_rollups`（按 (ip_hash, last_ts) 索引精确取行，不扫表）。
`--requests` 会额外读 ray_log_v2，那张表没有 ip_hash 索引（只能扫），默认关闭。

注意：**2026-09-26 之前的行没有密文**，只有不可逆的哈希。脚本把
「查不到这个 ID」和「有记录但没密文」分开返回，不会把后者误报成不存在。

用法：
    python3 ops/check_visitor_id.py d51153cb767fc758
    VISITOR_ID=d51153cb767fc758 python3 ops/check_visitor_id.py
    python3 ops/check_visitor_id.py d51153cb767fc758 --requests 10

退出码：0 解出 IP；1 无记录 / 查询失败 / 缺密钥；2 ID 非法；3 有记录但无密文。
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("LIMOOO_ROOT") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))

from ops import d1_client  # noqa: E402

ID_RE = re.compile(r"[0-9a-f]{16}")
SECRETS_FILE = ROOT / "secrets" / "webauthn.env"


def normalize(raw: str) -> str:
    """接受 'd51153cb767fc758' / 'ID: d51153cb767fc758' / 大写，统一成小写 16 位。"""
    value = (raw or "").strip()
    value = re.sub(r"^(?:id|visitor)[\s:=]+", "", value, flags=re.IGNORECASE).strip()
    value = value.lower()
    if not ID_RE.fullmatch(value):
        raise ValueError("invalid visitor ID")
    return value


def fmt_ts(value: object) -> str:
    if not isinstance(value, (int, float)):
        return "-"
    return dt.datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M:%S")


def d1_query_retry(cfg: dict[str, str], sql: str, tries: int = 4) -> list[dict]:
    """本机到 Cloudflare 偶发连接重置，统一退避重试；持续失败直接抛出。"""
    last: Exception | None = None
    for attempt in range(tries):
        try:
            return d1_client.d1_query(cfg, sql)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(str(last))


def decrypt_ip(token: str, key: str) -> str:
    """Fernet 解密；密钥/密文有问题时抛异常，由调用方给出可操作提示。"""
    try:
        from cryptography.fernet import Fernet
    except ImportError as exc:  # pragma: no cover - 取决于本机解释器
        raise RuntimeError(
            "当前解释器缺少 cryptography，无法解密 ip_enc。\n"
            "  用带依赖的解释器：/tmp/limooo-venv/bin/python "
            f"{Path(__file__).name} <ID>\n"
            "  （重建：python3 -m venv /tmp/limooo-venv && "
            "/tmp/limooo-venv/bin/pip install -r ops/requirements.txt）"
        ) from exc
    return Fernet(key.encode("ascii")).decrypt(token.encode("ascii")).decode("utf-8")


def summarize(rows: list[dict]) -> str:
    return " ".join(f"{r['status']}×{r['n']}" for r in rows) or "-"


def main() -> int:
    parser = argparse.ArgumentParser(description="按访客 ID 反查真实 IP 与访问概况")
    parser.add_argument("visitor_id", nargs="?", help="访客页显示的 16 位 ID（ip_hash）")
    parser.add_argument(
        "--requests",
        type=int,
        default=0,
        metavar="N",
        help="额外列出最近 N 条请求明细（读 ray_log_v2；该表无 ip_hash 索引，会扫表）",
    )
    args = parser.parse_args()

    raw = args.visitor_id or os.environ.get("VISITOR_ID") or ""
    try:
        visitor = normalize(raw)
    except ValueError:
        print("invalid visitor ID（应为 16 位十六进制，如 d51153cb767fc758）", file=sys.stderr)
        return 2

    def warn(message: str) -> None:
        sys.stdout.flush()
        print(message, file=sys.stderr)
        sys.stderr.flush()

    env = d1_client.load_env(SECRETS_FILE)
    key = (os.environ.get("VISITOR_IP_KEY") or env.get("VISITOR_IP_KEY") or "").strip()
    cfg = d1_client.cloudflare_config(env)

    print(f"== 访客 {visitor} ==", flush=True)
    try:
        totals = d1_query_retry(
            cfg,
            "SELECT COUNT(*) AS rows_n, COALESCE(SUM(requests), 0) AS total_requests, "
            "MIN(last_ts) AS first_ts, MAX(last_ts) AS last_ts, "
            "GROUP_CONCAT(DISTINCT NULLIF(country, '')) AS countries "
            f"FROM visitor_rollups WHERE ip_hash = '{visitor}'",
        )
    except Exception as exc:  # noqa: BLE001
        warn(f"  D1 查询失败: {exc}")
        warn(f"\n查询未完成：{visitor}（不代表没有记录，请重试）")
        return 1

    row = totals[0] if totals else {}
    if not row or not row.get("rows_n"):
        warn(f"\n未找到记录：{visitor}（该 ID 不在 visitor_rollups 保留窗口内）")
        return 1

    statuses = d1_query_retry(
        cfg,
        "SELECT status, SUM(requests) AS n FROM visitor_rollups "
        f"WHERE ip_hash = '{visitor}' GROUP BY status ORDER BY n DESC",
    )
    pages = d1_query_retry(
        cfg,
        "SELECT page_slug, SUM(requests) AS n FROM visitor_rollups "
        f"WHERE ip_hash = '{visitor}' GROUP BY page_slug ORDER BY n DESC LIMIT 8",
    )

    print(f"  首次      {fmt_ts(row.get('first_ts'))}")
    print(f"  最近      {fmt_ts(row.get('last_ts'))}")
    print(f"  请求      {row.get('total_requests')} 次 / {row.get('rows_n')} 个聚合行")
    print(f"  国家      {row.get('countries') or '-'}")
    print(f"  状态      {summarize(statuses)}")
    print("  页面      " + (" ".join(f"{r['page_slug']}×{r['n']}" for r in pages) or "-"))

    # 密文只取最近一条：同一个 IP 的小时行很多，但密文内容一致。
    tokens = d1_query_retry(
        cfg,
        "SELECT ip_enc, last_ts FROM visitor_rollups "
        f"WHERE ip_hash = '{visitor}' AND ip_enc != '' ORDER BY last_ts DESC LIMIT 1",
    )
    token = (tokens[0].get("ip_enc") if tokens else "") or ""

    if not token:
        print("  IP        不可用")
        warn(
            "\n该访客只有 2026-09-26 之前的记录：当时只存了 HMAC 哈希，不可逆。\n"
            "同一个 IP 之后再访问一次，这一行就会自动带上可解密的 IP。"
        )
        return 3

    if not key:
        warn(f"  找到密文，但 {SECRETS_FILE} 里没有 VISITOR_IP_KEY，无法解密。")
        return 1
    try:
        ip = decrypt_ip(token, key)
    except Exception as exc:  # noqa: BLE001
        warn(f"  解密失败: {exc}")
        return 1

    print(f"  IP        {ip}")
    print(f"  密文      最近一条 {fmt_ts(tokens[0].get('last_ts'))}（Fernet / VISITOR_IP_KEY，已本地解密）")

    if args.requests > 0:
        print(f"== 最近请求（ray_log_v2，最多 {args.requests} 条）==", flush=True)
        try:
            hits = d1_query_retry(
                cfg,
                "SELECT ts, host, normalized_path, method, status, country, ua_family "
                f"FROM ray_log_v2 WHERE ip_hash = '{visitor}' "
                f"ORDER BY ts DESC LIMIT {int(args.requests)}",
            )
        except Exception as exc:  # noqa: BLE001
            warn(f"  ray_log_v2 查询失败: {exc}")
            hits = []
        if not hits:
            print("  （保留窗口内没有明细记录）")
        for hit in hits:
            print(
                f"  {fmt_ts(hit.get('ts'))} {hit.get('host')} {hit.get('method')} "
                f"{hit.get('normalized_path')} {hit.get('status')} "
                f"country={hit.get('country')} ua={hit.get('ua_family')} [ray_log_v2]"
            )
    else:
        print("  （加 --requests 10 可列出该访客最近的请求明细）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
