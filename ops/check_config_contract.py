#!/usr/bin/env python3
"""部署前校验 config-contract.json、src/config.py 与生成的 functions/_lib/config.ts。

纯标准库实现，不引入新依赖。只要任意一侧与契约不一致，就以非 0 退出，
避免“边缘认识新域名、Flask 不认识”的配置漂移上线。
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "config-contract.json"
CONFIG_TS_PATH = ROOT / "functions" / "_lib" / "config.ts"
PYTHON_CONFIG_PATH = ROOT / "src" / "config.py"


PYTHON_FIELD_MAP = {
    "root_domain": "ROOT_DOMAIN",
    "supported_langs": "SUPPORTED_LANGS",
    "default_lang": "DEFAULT_LANG",
    "key_fallback_lang": "KEY_FALLBACK_LANG",
    "lang_cookie": "LANG_COOKIE",
    "lang_cookie_max_age": "LANG_COOKIE_MAX_AGE",
    "gate_cookie": "GATE_COOKIE",
    "session_cookie": "SESSION_COOKIE",
    "pending_cookie": "PENDING_COOKIE",
    "gate_ttl_seconds": "GATE_COOKIE_TTL",
    "session_ttl_seconds": "SESSION_TTL",
    "pending_ttl_seconds": "PENDING_TTL",
    "public_hosts": "PUBLIC_HOSTS",
    "authentik_provider_slug": "AUTHENTIK_PROVIDER_SLUG",
    "authentik_admin_groups": "AUTHENTIK_ADMIN_GROUPS",
}


def fail(message: str) -> None:
    print(f"[config-contract] FAIL: {message}", file=sys.stderr)


def load_contract() -> dict:
    try:
        with CONTRACT_PATH.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"无法读取或解析 {CONTRACT_PATH}: {exc}")
        raise SystemExit(1) from exc
    if not isinstance(data, dict):
        fail(f"{CONTRACT_PATH} 必须是 JSON 对象")
        raise SystemExit(1)
    return data


def load_python_config() -> dict:
    spec = importlib.util.spec_from_file_location("limooo_config_check", PYTHON_CONFIG_PATH)
    if spec is None or spec.loader is None:
        fail(f"无法加载 {PYTHON_CONFIG_PATH}")
        raise SystemExit(1)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_ts_contract() -> dict | None:
    if not CONFIG_TS_PATH.exists():
        # 生成物采用“生成不提交”策略：build.py 之前只校验 Python 侧，
        # 构建完成后 pages_deploy.sh 会再次校验 TS 侧。
        print(f"[config-contract] WARNING: 尚未生成 {CONFIG_TS_PATH}，跳过 TS 侧校验")
        return None
    try:
        text = CONFIG_TS_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        fail(f"无法读取 {CONFIG_TS_PATH}: {exc}")
        raise SystemExit(1) from exc
    match = re.search(r"export const CONTRACT = (\{.*?\}) as const;", text, re.S)
    if not match:
        fail(f"{CONFIG_TS_PATH} 缺少生成的 CONTRACT 常量，疑似被人手改")
        raise SystemExit(1)
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        fail(f"{CONFIG_TS_PATH} 的 CONTRACT 不是合法 JSON: {exc}")
        raise SystemExit(1) from exc


def compare(side: str, contract: dict, actual: dict) -> bool:
    ok = True
    for key, expected in contract.items():
        if key == "schema_version":
            continue
        got = actual.get(key, "<missing>")
        if got != expected:
            fail(f"{side}.{key}: expect {expected!r}, got {got!r}")
            ok = False
    return ok


def python_values(module) -> dict:
    result = {}
    for contract_key, python_name in PYTHON_FIELD_MAP.items():
        value = getattr(module, python_name, "<missing>")
        if isinstance(value, tuple):
            value = list(value)
        result[contract_key] = value
    return result


def main() -> int:
    contract = load_contract()
    if contract.get("schema_version") != 1:
        fail("当前仅支持 schema_version = 1")
        return 1

    module = load_python_config()
    py_ok = compare("src/config.py", contract, python_values(module))

    ts_contract = load_ts_contract()
    ts_ok = True
    if ts_contract is not None:
        # 生成文件里的 CONTRACT 会包含 schema_version；比较时跳过即可。
        actual_ts = {key: value for key, value in ts_contract.items() if key != "schema_version"}
        expect_ts = {key: value for key, value in contract.items() if key != "schema_version"}
        ts_ok = compare("functions/_lib/config.ts", expect_ts, actual_ts)

    if not (py_ok and ts_ok):
        return 1
    if ts_contract is None:
        print("[config-contract] OK: contract / Python 一致（TS 尚未生成，跳过）")
    else:
        print("[config-contract] OK: contract / Python / TypeScript 三者一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
