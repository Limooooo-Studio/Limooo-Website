#!/usr/bin/env python3
"""为 docs.limooo.cn 生成 Cloudflare Pages 的 `_headers`。

VitePress 会在 HTML 里内联三段脚本（主题桥接、check-dark-mode、check-mac-os）
和若干 style，因此不能直接照抄主站那份禁止 inline 的 CSP。这里扫描构建产物，
把真实出现的内联 <script>/<style> 内容算成 sha256 白名单，脚本侧不放开
unsafe-inline；style-src 仍保留 unsafe-inline（Vue 的 :style 绑定无法哈希）。

用法：
    python3 ops/docs_headers.py <dist-dir>
"""

from __future__ import annotations

import base64
import hashlib
import re
import sys
from pathlib import Path

SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.S | re.I)
STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S | re.I)

BASE_HEADERS = [
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("X-Frame-Options", "SAMEORIGIN"),
    ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
]


def digest(body: str) -> str:
    raw = hashlib.sha256(body.encode("utf-8")).digest()
    return "sha256-" + base64.b64encode(raw).decode("ascii")


def collect(dist: Path) -> tuple[list[str], list[str]]:
    scripts: set[str] = set()
    styles: set[str] = set()
    for html in dist.rglob("*.html"):
        text = html.read_text(encoding="utf-8", errors="replace")
        for body in SCRIPT_RE.findall(text):
            if body.strip():
                scripts.add(digest(body))
        for body in STYLE_RE.findall(text):
            if body.strip():
                styles.add(digest(body))
    return sorted(scripts), sorted(styles)


def csp(scripts: list[str], styles: list[str]) -> str:
    script_src = " ".join(["'self'", *scripts])
    style_src = " ".join(["'self'", "'unsafe-inline'", *styles])
    return "; ".join(
        [
            "default-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            f"script-src {script_src}",
            f"style-src {style_src}",
            "img-src 'self' data: https://image.limooo.cn https://images.limooo.cn",
            "font-src 'self' data:",
            "connect-src 'self'",
            "frame-ancestors 'self'",
            "form-action 'self' https://*.limooo.cn",
        ]
    )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: docs_headers.py <dist-dir>", file=sys.stderr)
        return 2
    dist = Path(sys.argv[1])
    if not dist.is_dir():
        print(f"FATAL: dist directory not found: {dist}", file=sys.stderr)
        return 1

    scripts, styles = collect(dist)
    lines: list[str] = ["/*"]
    for name, value in BASE_HEADERS:
        lines.append(f"  {name}: {value}")
    lines.append(f"  Content-Security-Policy: {csp(scripts, styles)}")
    lines.append("")
    lines.append("/assets/*")
    lines.append("  Cache-Control: public, max-age=31536000, immutable")
    lines.append("")
    lines.append("/logo.svg")
    lines.append("  Cache-Control: public, max-age=86400")

    (dist / "_headers").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(
        f"[docs-headers] wrote _headers (scripts={len(scripts)} styles={len(styles)}"
        f" inline hashes)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
