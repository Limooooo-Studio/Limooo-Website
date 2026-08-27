#!/usr/bin/env python3
"""统一导出 VPS SQLite 数据 → Cloudflare D1 导入 SQL/JSON。

用法：
    python3 ops/export_d1.py appleid [appleid.db 路径]
    python3 ops/export_d1.py blocklist
输出：ops/out/{appleid,blocklist}.sql/json（git 忽略）

旧的 ops/export_appleid.py / ops/export_blocklist.py 已并入此脚本。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_DIR = os.path.join(BASE_DIR, "ops", "out")
sys.path.insert(0, os.path.join(BASE_DIR, "src"))

from cidr import normalize_cidr, parse_cidr  # noqa: E402


def sql_str(value: object) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def export_appleid(db_path: str) -> int:
    if not os.path.exists(db_path):
        print(f"FATAL: {db_path} 不存在", file=sys.stderr)
        return 1
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, email, password, notes, sort_order, created_at, updated_at "
        "FROM apple_accounts ORDER BY id"
    ).fetchall()
    conn.close()

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "appleid.json"), "w", encoding="utf-8") as f:
        json.dump([dict(r) for r in rows], f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT_DIR, "appleid.sql"), "w", encoding="utf-8") as f:
        f.write(
            "INSERT OR IGNORE INTO apple_accounts "
            "(id, email, password, notes, sort_order, created_at, updated_at) VALUES\n"
        )
        values = [
            "("
            f"{r['id']}, {sql_str(r['email'])}, {sql_str(r['password'])}, {sql_str(r['notes'])}, "
            f"{int(r['sort_order'] or 0)}, {sql_str(r['created_at'])}, {sql_str(r['updated_at'])}"
            ")"
            for r in rows
        ]
        f.write(",\n".join(values) + ";\n")
    print(f"[export] {len(rows)} rows -> ops/out/appleid.sql / appleid.json", flush=True)
    return 0


def normalize_blocklist(line: str) -> str | None:
    """统一委托给 src/cidr.py，输出 canonical CIDR。"""
    return normalize_cidr(line)


def export_blocklist(src: str) -> int:
    if not os.path.exists(src):
        print(f"FATAL: {src} 不存在", file=sys.stderr)
        return 1
    seen: set[str] = set()
    with open(src, encoding="utf-8") as f:
        for raw in f:
            cidr = normalize_blocklist(raw)
            if cidr and cidr not in seen:
                seen.add(cidr)
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "blocklist.sql")
    with open(out, "w", encoding="utf-8") as f:
        f.write(
            "INSERT OR IGNORE INTO blocked_ips "
            "(cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active) VALUES\n"
        )
        values = []
        for c in sorted(seen):
            parsed = parse_cidr(c)
            if not parsed:
                continue
            network, prefix = parsed
            values.append(
                f"({sql_str(c)}, {sql_str(network)}, {prefix}, 'blocklist.txt', "
                "'auto_block', datetime('now'), datetime('now'), 'export_d1', 1)"
            )
        f.write(",\n".join(values) + ";\n" if values else "-- no rows\n")
    print(f"[export] {len(seen)} entries -> {out}", flush=True)
    return 0


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "appleid":
        db_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA_DIR, "appleid.db")
        return export_appleid(db_path)
    if command == "blocklist":
        src = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA_DIR, "blocklist.txt")
        return export_blocklist(src)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
