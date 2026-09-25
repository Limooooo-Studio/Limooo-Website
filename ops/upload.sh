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

# limooo.cn deploy script (quiet output) -- docs/17, zero-VPS
#
# Does the same work as ops/deploy.sh (commit / push / Pages / Worker);
# the ONLY difference is output: on success it prints one status line per step
# (Git: / Pages: / Deploy:), swallowing the build manifest, artifact count and
# wrangler upload progress; only on failure is the full log dumped to stderr.
# Use ops/deploy.sh when you want to watch the whole process.
#
#   bash ops/upload.sh                     # deploy Pages
#   bash ops/upload.sh --commit --push     # commit and push
#   bash ops/upload.sh --all               # commit + push + deploy Pages
#   bash ops/upload.sh --worker=status-worker
# Credentials are read from local secrets/webauthn.env; never written to disk or echoed.

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
        --help|-h) sed -n '20,32p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1" >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$DO_COMMIT" = 0 ] && [ "$DO_PUSH" = 0 ] && [ "$DO_PAGES" = 0 ] && [ -z "$WORKER" ]; then
    DO_PAGES=1
fi

if [ "$DRY_RUN" = 1 ]; then
    echo "Deploy start (dry-run)"
    [ "$DO_COMMIT" = 1 ] && echo "  would-run: git add -A && git commit"
    [ "$DO_PUSH" = 1 ] && echo "  would-run: git push origin main"
    [ "$DO_PAGES" = 1 ] && echo "  would-run: bash ops/pages_deploy.sh"
    [ -n "$WORKER" ] && echo "  would-run: bash ops/workers_deploy.sh --worker=$WORKER"
    echo "Deploy: dry-run done"
    exit 0
fi

echo "Deploy start"

# ── ① git commit ────────────────────────────────────────────────────
if [ "$DO_COMMIT" = 1 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git add -A -- . ':!limooo.cn.png'
    if ! git diff --cached --quiet; then
        git commit -m "deploy: auto-commit $(date '+%Y-%m-%d %H:%M')" >/dev/null
        echo "Git: committed local changes"
    else
        echo "Git: nothing to commit"
    fi
fi

# ── ② git push ──────────────────────────────────────────────────────
if [ "$DO_PUSH" = 1 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git fetch origin main >/dev/null 2>&1; then
        LOCAL_HEAD="$(git rev-parse HEAD)"
        REMOTE_HEAD="$(git rev-parse origin/main)"
        if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
            echo "Git: GitHub already up to date, skipped push"
        elif git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
            if git push origin main >/dev/null 2>&1; then
                echo "Git: pushed to GitHub"
            else
                echo "Warning: git push failed, continuing deploy" >&2
            fi
        elif git merge-base --is-ancestor "$LOCAL_HEAD" "$REMOTE_HEAD"; then
            echo "Warning: GitHub is newer, skipped push" >&2
        else
            echo "Warning: local and GitHub histories diverged, skipped push" >&2
        fi
    else
        echo "Warning: could not fetch GitHub state, skipped push" >&2
    fi
fi

# ── ③ Pages：只在失败时吐出日志，成功时只留一行状态 ─────────────────
if [ "$DO_PAGES" = 1 ]; then
    log="$(mktemp -t limooo-upload-XXXXXX.log)"
    trap 'rm -f "$log"' EXIT
    if bash ops/pages_deploy.sh >"$log" 2>&1; then
        # 成功路径刻意不打印任何中间信息：构建清单、产物数量、wrangler 上传
        # 进度、Functions bundle 提示全部丢弃。pages_deploy.sh 自己会在结束前
        # 校验 /_health = 200，失败即非 0 退出，所以这里不需要复述。
        echo "Pages: done"
    else
        echo "Pages: FAILED -- full log follows" >&2
        cat "$log" >&2
        exit 1
    fi
fi

# ── ④ 独立 Worker ───────────────────────────────────────────────────
if [ -n "$WORKER" ]; then
    log="$(mktemp -t limooo-worker-XXXXXX.log)"
    trap 'rm -f "$log"' EXIT
    if bash ops/workers_deploy.sh "--worker=$WORKER" >"$log" 2>&1; then
        echo "Worker: $WORKER deployed"
    else
        echo "Worker: $WORKER FAILED -- full log follows" >&2
        cat "$log" >&2
        exit 1
    fi
fi

echo "Deploy: done"
