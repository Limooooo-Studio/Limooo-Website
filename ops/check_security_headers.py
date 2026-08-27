#!/usr/bin/env python3
"""校验 ops/security-headers.json 与 Pages 侧 functions/_lib/security.ts 一致。

只依赖标准库。05 的安全头 JSON 是唯一文案源，本脚本用于防止两侧镜像漂移。
运行：
    python3 ops/check_security_headers.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "ops" / "security-headers.json"
TS_PATH = ROOT / "functions" / "_lib" / "security.ts"


def main() -> int:
    expected = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    if not isinstance(expected, dict):
        print("FATAL: security-headers.json 必须是 JSON 对象", file=sys.stderr)
        return 1

    ts = TS_PATH.read_text(encoding="utf-8")
    errors: list[str] = []
    for name, value in expected.items():
        pattern = re.compile(
            rf'"{re.escape(name)}"\s*:\s*"((?:\\.|[^"\\])*)"',
        )
        match = pattern.search(ts)
        if not match:
            errors.append(f"security.ts 缺少字段 {name}")
            continue
        actual = json.loads(f'"{match.group(1)}"')
        if actual != value:
            errors.append(f"security.ts {name}: JSON={value!r} 实际={actual!r}")
        if name == "Content-Security-Policy":
            if "'unsafe-inline'" in actual:
                errors.append("CSP 仍包含 'unsafe-inline'，docs/14 不允许")
            script_src = re.search(r"script-src ([^;]+)", actual)
            style_src = re.search(r"style-src ([^;]+)", actual)
            for section, match in (("script-src", script_src), ("style-src", style_src)):
                if match and "https://limooo.cn" in match.group(1):
                    errors.append(f"CSP {section} 仍放行 https://limooo.cn，应使用 'self'")

    if errors:
        print("FATAL: 安全响应头校验失败", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("security headers: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
