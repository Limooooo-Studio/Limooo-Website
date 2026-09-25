#!/usr/bin/env bash

# Limooo - Flask Web Application
#
# Copyright (C) 2026 Limooo <https://limooo.cn/>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# 本地复刻 .github/workflows/tests.yml。
#
# 为什么要这个脚本：CI 是「先 build 再 typecheck / 测试」，本地如果只跑
# vitest/pytest，就会出现「本地全绿、push 后 CI 红」。典型翻车是生成的
# functions/_lib/config.ts 与 src/build.py 不同步（改名只改了一半），
# 本地工作区恰好是自洽的，而提交进去的那棵树不是。
#
# 所以：push 之前用这个脚本跑一遍，CI 会跑什么，这里就跑什么。
#
# 用法：
#   bash ops/ci_check.sh                # 检查当前工作区
#   bash ops/ci_check.sh --ref=<rev>    # 把 <rev> 检出到临时 worktree 再检查
#                                       # （校验「将要 push 的那个提交」，即使工作区很脏）
#   bash ops/ci_check.sh --typescript   # 只跑 typescript job
#   bash ops/ci_check.sh --python       # 只跑 python job
#   bash ops/ci_check.sh --no-build     # 跳过 build（假定产物已是新的）
#
# 退出码 0 = CI 会绿；非 0 = CI 会红，别 push。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REF=""
RUN_TS=1
RUN_PY=1
DO_BUILD=1

while [ $# -gt 0 ]; do
    case "$1" in
        --ref=*) REF="${1#--ref=}" ;;
        --typescript) RUN_PY=0 ;;
        --python) RUN_TS=0 ;;
        --no-build) DO_BUILD=0 ;;
        --help|-h) sed -n '20,38p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1" >&2
            echo "       supported: --ref=<rev> / --typescript / --python / --no-build" >&2
            exit 2
            ;;
    esac
    shift
done

# ── 隔离的构建输出：别在 iCloud 同步区里反复 rm -rf public/ ──────────
export LIMOOO_PUBLIC_DIR="${LIMOOO_PUBLIC_DIR:-/tmp/limooo-ci-public}"
export LIMOOO_PREVIEW_DIR="${LIMOOO_PREVIEW_DIR:-/tmp/limooo-ci-preview}"

# Python 解释器：优先用构建 venv（依赖齐），其次 python3。
PYTHON_BIN="${PYTHON_BIN:-python3}"
if [ -x "$ROOT/.venv-build/bin/python" ]; then
    PYTHON_BIN="$ROOT/.venv-build/bin/python"
fi

WORKTREE=""
cleanup() {
    if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
        git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
    fi
}
trap cleanup EXIT

# ── 选定要检查的树 ──────────────────────────────────────────────────
TARGET="$ROOT"
if [ -n "$REF" ]; then
    if ! git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
        echo "FATAL: not a commit: $REF" >&2
        exit 2
    fi
    WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/limooo-ci-check.XXXXXX")"
    # git worktree add 要求目录为空或不存在
    rmdir "$WORKTREE"
    git worktree add --detach "$WORKTREE" "$REF" >/dev/null
    # 复用主仓库的依赖，避免在临时目录里重新装一遍
    [ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$WORKTREE/node_modules"
    [ -d "$ROOT/.venv-build" ] && ln -s "$ROOT/.venv-build" "$WORKTREE/.venv-build"
    TARGET="$WORKTREE"
    echo "[ci] checking ref $REF (tree at $TARGET)"
else
    echo "[ci] checking working tree at $ROOT"
fi

# ── 守卫 1：iCloud 冲突副本（"build 2.py" 这类）绝不能进仓库 ─────────
CONFLICTS="$(cd "$TARGET" && find functions src locales tests ops .github \
    \( -name node_modules -o -name .venv-build -o -name .wrangler \
       -o -name out -o -name kuma-dist \) -prune -o \
    -type f \( -name '* [0-9]' -o -name '* [0-9].*' \) -print 2>/dev/null | sort)"
if [ -n "$CONFLICTS" ]; then
    echo "[ci] FAIL: 检测到 iCloud 冲突副本（'xxx 2.ext'），提交前先处理掉：" >&2
    echo "$CONFLICTS" | head -20 | sed 's/^/       /' >&2
    echo "       确认与正本一致后删除：rm -f 'functions/_data/runtime 2.ts' ..." >&2
    exit 1
fi

# ── 守卫 2：生成的 TS 产物必须由 build 现场再生，且与仓库一致 ────────
# build 之后如果 functions/_lib/config.ts、functions/_data/*.ts、
# src/config.py 相对 HEAD 有差异，说明提交时忘了带上它们 —— 这正是 CI 变红的根因。
GENERATED_PATHS=(functions/_lib/config.ts functions/_data src/config.py)

echo "[ci] ===== typescript job ====="
if [ "$RUN_TS" = 1 ]; then
    if [ ! -d "$TARGET/node_modules" ]; then
        echo "[ci] FAIL: $TARGET/node_modules 不存在，先 npm ci" >&2
        exit 1
    fi

    if [ "$DO_BUILD" = 1 ]; then
        echo "[ci] npm run build"
        (cd "$TARGET" && npm run build)
    fi

    if [ -n "$REF" ]; then
        drift="$(cd "$TARGET" && git status --porcelain -- "${GENERATED_PATHS[@]}" 2>/dev/null || true)"
        if [ -n "$drift" ]; then
            echo "[ci] FAIL: $REF 里的生成产物与 src/build.py + config-contract.json 不一致：" >&2
            echo "$drift" | sed 's/^/       /' >&2
            echo "       把改到的 generator 源头（src/build.py / config-contract.json / locales/）一起提交。" >&2
            exit 1
        fi
    fi

    echo "[ci] npm run typecheck"
    (cd "$TARGET" && npm run typecheck)

    echo "[ci] bash ops/migrate_d1.sh --dry-run"
    (cd "$TARGET" && bash ops/migrate_d1.sh --dry-run)

    echo "[ci] npm test"
    (cd "$TARGET" && npm test)
fi

if [ "$RUN_PY" = 1 ]; then
    echo "[ci] ===== python job ====="
    echo "[ci] python -m pytest"
    (cd "$TARGET" && "$PYTHON_BIN" -m pytest -q)
fi

echo "[ci] OK: CI 会绿。"
