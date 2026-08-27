#!/usr/bin/env python3
"""从 data/whitelist.txt 与 config-contract.json 生成门禁信任配置（docs/14）。

输出：
  - 校验白名单格式；
  - `--emit` 时生成 functions/_data/gateTrust.ts；
  - 不读取任何密钥。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = ROOT / "config-contract.json"
WHITELIST_PATH = ROOT / "data" / "whitelist.txt"
OUTPUT_PATH = ROOT / "functions" / "_data" / "gateTrust.ts"

ASN_RE = re.compile(r"^ASN/(\d{1,10})$", re.I)
IP_CIDR_RE = re.compile(
    r"^IP-CIDR/([0-9A-Fa-f:.]+)/(\d{1,3})$",
    re.I,
)


def load_whitelist(path: Path) -> tuple[list[int], list[tuple[str, int]]]:
    asns: list[int] = []
    networks: list[tuple[str, int]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise RuntimeError(f"无法读取白名单 {path}: {exc}") from exc

    for raw in lines:
        line = re.sub(r"#.*$", "", raw).strip()
        if not line:
            continue
        asn = ASN_RE.match(line)
        if asn:
            asns.append(int(asn.group(1)))
            continue
        cidr = IP_CIDR_RE.match(line)
        if cidr:
            prefix = int(cidr.group(2))
            if prefix < 0 or prefix > 128:
                raise RuntimeError(f"非法 CIDR 前缀: {line}")
            networks.append((cidr.group(1), prefix))
            continue
        raise RuntimeError(f"无法解析白名单行: {line}")

    return sorted(set(asns)), networks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit", action="store_true", help="写入 gateTrust.ts")
    args = parser.parse_args()

    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    gate_trust = contract.get("gate_trust", {})
    asns, networks = load_whitelist(WHITELIST_PATH)

    payload = {
        "verified_bot": gate_trust.get("verified_bot", True),
        "ua_allowlist_enabled": gate_trust.get("ua_allowlist_enabled", False),
        "low_risk_asns": asns,
        "ip_cidrs": networks,
    }

    if args.emit:
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        ts = (
            "// 由 ops/check_gate_trust.py 从 data/whitelist.txt 自动生成，勿手改。\n"
            f"export const GATE_TRUST = {json.dumps(payload, ensure_ascii=False)} as const;\n"
            f"export const LOW_RISK_ASNS: Set<number> = new Set({json.dumps(asns)});\n"
            f"export const GATE_TRUST_IPS: Set<string> = new Set({json.dumps([ip for ip, _ in networks])});\n"
            f"export const GATE_TRUST_NETWORKS: [string, number][] = {json.dumps(networks)};\n"
        )
        OUTPUT_PATH.write_text(ts, encoding="utf-8")

    print(
        json.dumps(
            {
                "ok": True,
                "verified_bot": payload["verified_bot"],
                "ua_allowlist_enabled": payload["ua_allowlist_enabled"],
                "asns": len(asns),
                "ip_cidrs": len(networks),
                "emitted": str(OUTPUT_PATH) if args.emit else None,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
