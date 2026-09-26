#!/usr/bin/env python3

"""按客户端 IP 反查它最近的 Ray ID（D1 双表），供管理员终端排障。

为什么不是「直接按 IP 查表」：
    D1 里 IP 是脱敏存储的，两张表各有一半信息 ——
      1. `ray_log_v2`（保留 7 天）有 ray/时间/host/路径/状态，但只有
         `ip_hash`（OBSERVABILITY_HMAC_KEY 的 HMAC-SHA256 前 16 位）。
         该密钥是 Pages 的 write-only Secret，本机拿不到，无法现算。
      2. `visitor_rollups.ip_enc` 是 Fernet 密文（`VISITOR_IP_KEY`，本机有），
         能还原**明文 IP**，并带同一行的 `ip_hash`。
    所以链路是：明文 IP → 在所有 ip_enc 里找出匹配行 → 拿到 ip_hash
    → 用 ip_hash 去 ray_log_v2 取最近 N 条 ray。

    `ray_log`（旧表）存的是明文 IP，可直接精确匹配，但 2026-09-25 起已停写，
    故仅作历史兜底。

用法：
    python3 ops/check_ip_rays.py 176.122.161.108
    python3 ops/check_ip_rays.py 176.122.161.108 --limit 5
    python3 ops/check_ip_rays.py --hash d51153cb767fc758   # 已知 ip_hash 时跳过解密
    python3 ops/check_ip_rays.py 8.8.8.8 --json

退出码：0 有命中；1 无命中或查询失败；2 参数非法。
"""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("LIMOOO_ROOT") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))

from ops import d1_client  # noqa: E402

DEFAULT_LIMIT = 3

# ip_enc 需要 cryptography；缺失时只降级掉「IP → hash」这半步，不影响 --hash。
try:
    from cryptography.fernet import Fernet, InvalidToken  # noqa: E402
except ImportError:  # pragma: no cover - 取决于解释器
    Fernet = None  # type: ignore[assignment]

    class InvalidToken(Exception):  # type: ignore[no-redef]
        """占位：cryptography 缺失时也不会被用到。"""


def normalize_ip(raw: str) -> str:
    """校验并归一化 IP（IPv4/IPv6）；非法时抛 ValueError。"""
    value = (raw or "").strip()
    if not value:
        raise ValueError("empty IP")
    # 去掉 curl/日志里常见的方括号与端口： [::1]:443 / 1.2.3.4:80
    if value.startswith("["):
        value = value[1:].split("]", 1)[0]
    else:
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            pass
        if value.count(":") == 1 and "." in value:
            value = value.split(":", 1)[0]
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as exc:
        raise ValueError(f"invalid IP: {raw}") from exc


def looks_like_hash(raw: str) -> bool:
    value = (raw or "").strip().lower()
    return len(value) == 16 and all(ch in "0123456789abcdef" for ch in value)


def d1_query_retry(cfg: dict[str, str], sql: str, tries: int = 4) -> list[dict] | None:
    """D1 查询带退避重试；持续失败返回 None（与「确实没记录」区分开）。"""
    for attempt in range(tries):
        try:
            return d1_client.d1_query(cfg, sql)
        except Exception:  # noqa: BLE001 - 本机到 CF 偶发连接重置
            if attempt == tries - 1:
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def visitor_key(env: dict[str, str]) -> str:
    return d1_client.env_value(env, "VISITOR_IP_KEY")


def resolve_hashes(cfg: dict[str, str], env: dict[str, str], ip: str) -> tuple[list[str], str | None]:
    """明文 IP → ip_hash 集合：解密所有 ip_enc 行并比对。

    返回 (hash 列表, 警告)。警告非空表示链路降级或不完整，调用方需如实提示，
    不能把「解不出来」说成「没有记录」。
    """
    key = visitor_key(env)
    if not key:
        return [], "缺少 VISITOR_IP_KEY，无法解密 ip_enc（只能用 --hash 或旧表 ray_log）"
    if Fernet is None:
        return [], "当前 python 没有 cryptography，无法解密 ip_enc（改用带该依赖的解释器）"

    rows = d1_query_retry(cfg, "SELECT ip_hash, ip_enc, last_ts FROM visitor_rollups WHERE ip_enc IS NOT NULL AND ip_enc != ''")
    if rows is None:
        return [], "visitor_rollups 查询失败（网络/API 抖动，不代表无记录）"

    try:
        fernet = Fernet(key.encode())
    except Exception:  # noqa: BLE001
        return [], "VISITOR_IP_KEY 不是合法 Fernet 密钥"

    target = ipaddress.ip_address(ip)
    hashes: list[str] = []
    for row in rows:
        token = row.get("ip_enc") or ""
        if not token:
            continue
        try:
            candidate = fernet.decrypt(str(token).encode()).decode()
        except (InvalidToken, ValueError, TypeError):
            continue  # 换过密钥的历史行解不开，跳过
        try:
            if ipaddress.ip_address(candidate) != target:
                continue
        except ValueError:
            continue
        row_hash = str(row.get("ip_hash") or "").strip()
        if row_hash and row_hash not in hashes:
            hashes.append(row_hash)

    if not hashes:
        # ip_enc 只覆盖启用该功能之后的行，空结果不等于「该 IP 没来过」。
        return [], "ip_enc 中没有该 IP（该列只覆盖启用加密之后的记录，可能是更早的历史访问）"
    return hashes, None


def rays_by_hash(cfg: dict[str, str], hashes: list[str], limit: int) -> tuple[list[dict], str | None]:
    """按 ip_hash 从 ray_log_v2 取最近 limit 条。"""
    if not hashes:
        return [], None
    quoted = ", ".join("'" + h.replace("'", "''") + "'" for h in hashes)
    sql = (
        "SELECT ray, ts, host, normalized_path AS path, method, status, country, ip_hash, duration_ms "
        f"FROM ray_log_v2 WHERE ip_hash IN ({quoted}) ORDER BY ts DESC LIMIT {int(limit)}"
    )
    rows = d1_query_retry(cfg, sql)
    if rows is None:
        return [], "ray_log_v2 查询失败（网络/API 抖动，不代表无记录）"
    return rows, None


def rays_legacy(cfg: dict[str, str], ip: str, limit: int) -> tuple[list[dict], str | None]:
    """旧表 ray_log 明文 IP 精确匹配（2026-09-25 已停写，仅历史兜底）。"""
    sql = (
        "SELECT ray, ts, host, path, method, status, country, ip "
        f"FROM ray_log WHERE ip = '{ip.replace(chr(39), chr(39) * 2)}' ORDER BY ts DESC LIMIT {int(limit)}"
    )
    rows = d1_query_retry(cfg, sql)
    if rows is None:
        return [], "ray_log 查询失败（网络/API 抖动，不代表无记录）"
    return rows, None


def render_v2(row: dict) -> str:
    ts = row.get("ts")
    stamp = dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if isinstance(ts, (int, float)) else ""
    host = row.get("host", "")
    method = row.get("method", "")
    path = row.get("path", "")
    status = row.get("status", "")
    country = row.get("country", "")
    duration = row.get("duration_ms")
    ms = f" {duration}ms" if isinstance(duration, (int, float)) and duration else ""
    return f"{stamp} {row.get('ray','')} {host} {method} {path} {status} country={country}{ms}"


def render_legacy(row: dict) -> str:
    ts = row.get("ts")
    stamp = dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if isinstance(ts, (int, float)) else ""
    return (
        f"{stamp} {row.get('ray','')} {row.get('host','')} {row.get('method','')} "
        f"{row.get('path','')} {row.get('status','')} country={row.get('country','')} [legacy]"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="按客户端 IP 反查最近的 Ray ID")
    parser.add_argument("target", nargs="?", help="客户端 IP，如 176.122.161.108 / 240e:404::1")
    parser.add_argument("--hash", dest="hash_value", help="已知 ip_hash（16 位 hex），跳过 IP 解密")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"返回条数（默认 {DEFAULT_LIMIT}）")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出，便于脚本消费")
    args = parser.parse_args()

    limit = max(1, args.limit)
    env = d1_client.load_env(ROOT / "secrets" / "webauthn.env")
    cfg = d1_client.cloudflare_config(env)

    warnings: list[str] = []
    hashes: list[str] = []
    ip = ""

    if args.hash_value:
        raw_hash = args.hash_value.strip().lower()
        if not looks_like_hash(raw_hash):
            print("invalid ip_hash (expect 16 hex chars)", file=sys.stderr)
            return 2
        hashes = [raw_hash]
    else:
        try:
            ip = normalize_ip(args.target or "")
        except ValueError:
            print("invalid IP", file=sys.stderr)
            return 2
        hashes, warn = resolve_hashes(cfg, env, ip)
        if warn:
            warnings.append(warn)

    rows, warn = rays_by_hash(cfg, hashes, limit)
    if warn:
        warnings.append(warn)

    legacy: list[dict] = []
    if ip and len(rows) < limit:
        # v2 命中不足时，用旧表补齐（旧表有明文 IP）。
        extra, warn2 = rays_legacy(cfg, ip, limit - len(rows))
        if warn2:
            warnings.append(warn2)
        legacy = [r for r in extra if r.get("ray") not in {x.get("ray") for x in rows}]

    if args.json:
        print(json.dumps(
            {
                "ip": ip or None,
                "ip_hashes": hashes,
                "rays": rows,
                "legacy_rays": legacy,
                "warnings": warnings,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        ))
        return 0 if (rows or legacy) else 1

    label = ip or f"hash:{hashes[0]}"
    print(f"== {label} 最近 {limit} 条 Ray ==", flush=True)
    if hashes:
        print(f"   ip_hash: {', '.join(hashes)}")
    for row in rows:
        print("  " + render_v2(row))
    for row in legacy:
        print("  " + render_legacy(row))

    for warn in warnings:
        print(f"   note: {warn}", file=sys.stderr)

    if not rows and not legacy:
        print(f"\n未找到记录：{label}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
