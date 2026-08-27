#!/usr/bin/env python3

"""Limooo 与 Cloudflare D1 API 的共享客户端。

只负责环境变量读取与 HTTP 查询；不回显 token/value。供 check_health.py、
prune_d1.py 等运维脚本复用。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from config import CLOUDFLARE_API_BASE, D1_DATABASE_ID  # noqa: E402


def load_env(*paths: str | Path) -> dict[str, str]:
    """读取 env 文件；文件不存在时返回空字典，绝不回显值。"""
    result: dict[str, str] = {}
    for raw_path in paths:
        path = Path(raw_path)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


def env_value(env: dict[str, str], *names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
        value = env.get(name)
        if value:
            return value
    return default


def cloudflare_config(env: dict[str, str]) -> dict[str, str]:
    return {
        "token": env_value(env, "CLOUDFLARE_API_TOKEN"),
        "account_id": env_value(env, "CLOUDFLARE_ACCOUNT_ID"),
        "database_id": env_value(env, "D1_DATABASE_ID", default=D1_DATABASE_ID),
    }


def d1_query(cfg: dict[str, str], sql: str) -> list[dict[str, Any]]:
    """向 D1 API 发送单条 SQL；写操作同样通过 query 接口执行。"""
    token = cfg["token"]
    account_id = cfg["account_id"]
    database_id = cfg["database_id"]
    if not token or not account_id or not database_id:
        raise RuntimeError("Cloudflare / D1 配置缺失")
    url = f"{CLOUDFLARE_API_BASE}/accounts/{account_id}/d1/database/{database_id}/query"
    body = json.dumps({"sql": sql}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"D1 HTTP {exc.code}: {detail}") from exc
    if not data.get("success"):
        raise RuntimeError(f"D1 API 返回失败: {str(data)[:300]}")
    results = data.get("result") or []
    if not results:
        return []
    first = results[0] or {}
    if not first.get("success"):
        raise RuntimeError(f"D1 查询失败: {str(first)[:300]}")
    return first.get("results") or []
