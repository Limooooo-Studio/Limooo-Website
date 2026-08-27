#!/usr/bin/env bash
# 本地全量测试入口：Python pytest + TypeScript vitest。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== Python tests =="
PYTHON_BIN="${PYTHON_BIN:-python3}"
if [ -x "$PWD/.venv-build/bin/python" ]; then
    PYTHON_BIN="$PWD/.venv-build/bin/python"
fi
"$PYTHON_BIN" -m pytest

echo "== TypeScript tests =="
if command -v npm >/dev/null 2>&1 && [ -f package.json ]; then
    echo "== TypeScript typecheck =="
    npm run typecheck
    npm test
else
    echo "WARNING: npm/package.json 不存在，跳过 vitest" >&2
fi
