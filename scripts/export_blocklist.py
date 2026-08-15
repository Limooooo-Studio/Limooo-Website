#!/usr/bin/env python3
"""把 data/blocklist.txt 规范化成 blocked_ips 的 D1 种子 SQL

支持三种格式：单 IP、CIDR、裸 /24 前缀（a.b.c）。行内 # 注释会被剥离。
用法：python3 scripts/export_blocklist.py
输出：scripts/out/blocklist.sql
"""

import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE_DIR, "data", "blocklist.txt")
OUT_DIR = os.path.join(BASE_DIR, "scripts", "out")


def normalize(line: str) -> str | None:
    line = re.sub(r"#.*$", "", line).strip()
    if not line:
        return None
    # 裸 /24 前缀 a.b.c → a.b.c.0/24
    if re.fullmatch(r"\d{1,3}\.\d{1,3}\.\d{1,3}", line):
        return f"{line}.0/24"
    if re.fullmatch(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", line):
        return line
    if re.fullmatch(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d{1,2}", line):
        return line
    return None


def main() -> int:
    if not os.path.exists(SRC):
        print(f"FATAL: {SRC} 不存在", file=sys.stderr)
        return 1
    seen: set[str] = set()
    with open(SRC, encoding="utf-8") as f:
        for raw in f:
            cidr = normalize(raw)
            if cidr and cidr not in seen:
                seen.add(cidr)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "blocklist.sql")
    with open(out, "w", encoding="utf-8") as f:
        f.write("INSERT OR IGNORE INTO blocked_ips (cidr, note) VALUES\n")
        f.write(",\n".join(f"('{c}', 'blocklist.txt')" for c in sorted(seen)))
        f.write(";\n")
    print(f"[export] {len(seen)} entries -> {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
