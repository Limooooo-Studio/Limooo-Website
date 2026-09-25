#!/bin/bash

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

# limooo.cn full deploy entrypoint (docs/17, zero-VPS)
#
# The VPS was retired on 2026-09-17: no ssh, no rsync, no remote restart, no nginx.
# Full deploy = (1) git commit -> (2) git push -> (3) Cloudflare Pages (+ related Workers).
#
# Usage:
#   bash ops/deploy.sh --dry-run                # print what would happen only
#   bash ops/deploy.sh --commit                 # commit only
#   bash ops/deploy.sh --commit --push          # commit and push
#   bash ops/deploy.sh --all                    # commit + push + deploy Pages
#   bash ops/deploy.sh --worker=status-worker   # deploy one standalone Worker only
#
# With no arguments: deploy Pages only (no commit / no push), matching the old script.
# Credentials are read from local secrets/webauthn.env; never written to disk or echoed.
#
# 提交/推送前会先跑 ops/ci_check.sh（本地复刻 .github/workflows/tests.yml）：
# 「先 build 再 typecheck/测试」，红了就中止，不提交也不推送。应急跳过：
#   LIMOOO_SKIP_CHECKS=1 bash ops/deploy.sh --all

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DO_COMMIT=0
DO_PUSH=0
DO_PAGES=0
WORKER=""
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --commit) DO_COMMIT=1 ;;
        --push) DO_PUSH=1 ;;
        --pages) DO_PAGES=1 ;;
        --all) DO_COMMIT=1; DO_PUSH=1; DO_PAGES=1 ;;
        --worker=*) WORKER="${1#--worker=}" ;;
        --help|-h) sed -n '20,37p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1" >&2
            echo "       supported: --dry-run / --commit / --push / --pages / --all / --worker=<name>" >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$DO_COMMIT" = 0 ] && [ "$DO_PUSH" = 0 ] && [ "$DO_PAGES" = 0 ] && [ -z "$WORKER" ]; then
    DO_PAGES=1
fi

if [ "$DRY_RUN" = 1 ]; then
    echo "[deploy] DRY-RUN: no git writes, no Cloudflare writes."
    { [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ]; } && echo "[deploy] will-run: bash ops/ci_check.sh（本地复刻 CI，红了就中止）"
    [ "$DO_COMMIT" = 1 ] && echo "[deploy] will-run: git add -A && git commit"
    [ "$DO_PUSH" = 1 ] && echo "[deploy] will-run: git push origin main"
    [ "$DO_PAGES" = 1 ] && echo "[deploy] will-run: bash ops/pages_deploy.sh"
    [ -n "$WORKER" ] && echo "[deploy] will-run: bash ops/workers_deploy.sh --worker=$WORKER"
    exit 0
fi

# ── ⓪ 本地 CI 复刻（必须先于 commit / push）──────────────────────────
# 历史教训：CI 是「先 build 再 typecheck / 测试」，而本地只跑过 vitest/pytest，
# 于是「本地全绿、push 完 30 秒收到失败通知」。这里把 CI 原样跑一遍。
if [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ]; then
    if [ "${LIMOOO_SKIP_CHECKS:-0}" = 1 ]; then
        echo "[deploy] (0/3) LIMOOO_SKIP_CHECKS=1，跳过本地 CI 复刻"
    elif [ "$DO_COMMIT" = 1 ]; then
        echo "[deploy] (0/3) 本地 CI 复刻（工作区）"
        bash ops/ci_check.sh
    else
        echo "[deploy] (0/3) 本地 CI 复刻（HEAD）"
        bash ops/ci_check.sh --ref=HEAD
    fi
fi

# ── ① git commit ────────────────────────────────────────────────────
if [ "$DO_COMMIT" = 1 ]; then
    echo "[deploy] (1/3) git commit"
    git add -A -- . ':!limooo.cn.png'
    if git diff --cached --quiet; then
        echo "[deploy] nothing to commit, skipping commit"
    else
        git commit -m "deploy: $(date '+%Y-%m-%d %H:%M')"
    fi
    # 刚提交的这棵树就是 ⓪ 里检查过的内容，pre-push hook 不必再跑一遍。
    export LIMOOO_CI_CHECKED_SHA="$(git rev-parse HEAD)"
fi

# ── ② git push ──────────────────────────────────────────────────────
if [ "$DO_PUSH" = 1 ]; then
    echo "[deploy] (2/3) git push"
    git fetch origin main
    LOCAL_HEAD="$(git rev-parse HEAD)"
    REMOTE_HEAD="$(git rev-parse origin/main)"
    if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
        echo "[deploy] already up to date with origin/main, no push needed"
    elif git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
        git push origin main
    else
        echo "FATAL: local and origin/main have diverged, resolve manually (rebase/merge) first" >&2
        exit 1
    fi
fi

# ── ③ Cloudflare Pages ──────────────────────────────────────────────
if [ "$DO_PAGES" = 1 ]; then
    echo "[deploy] (3/3) Cloudflare Pages"
    bash ops/pages_deploy.sh
fi

# ── 独立 Worker（可选，与 Pages 互不影响）────────────────────────────
if [ -n "$WORKER" ]; then
    echo "[deploy] Worker: $WORKER"
    bash ops/workers_deploy.sh "--worker=$WORKER"
fi

echo "[deploy] done."
