#!/usr/bin/env python3
"""导出 appleid.db → D1 导入 SQL/JSON（密码字段原样保留，不解密）

用法：python3 scripts/export_appleid.py [appleid.db 路径]
输出：scripts/out/appleid.sql、scripts/out/appleid.json
导入：wrangler d1 execute limooo --file=scripts/out/appleid.sql
"""

import json
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "scripts", "out")


def esc(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def main() -> int:
    db_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE_DIR, "data", "appleid.db")
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
            f"{r['id']}, {esc(r['email'])}, {esc(r['password'])}, {esc(r['notes'])}, "
            f"{int(r['sort_order'] or 0)}, {esc(r['created_at'])}, {esc(r['updated_at'])}"
            ")"
            for r in rows
        ]
        f.write(",\n".join(values) + ";\n")

    print(f"[export] {len(rows)} rows -> scripts/out/appleid.sql / appleid.json", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
