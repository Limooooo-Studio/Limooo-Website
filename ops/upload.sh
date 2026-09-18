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

# limooo.cn 部署脚本（输出精简版）—— docs/17 零 VPS 版
#
# 与 ops/deploy.sh 做同样的事（commit / push / Pages / Worker），
# **唯一区别是输出**：成功时只打印一行行程式状态（Git: / Pages: / Deploy:），
# 构建与 wrangler 的冗长日志被吞掉；只有出错时才把完整日志吐出来。
# 需要看全过程请用 ops/deploy.sh。
#
#   bash ops/upload.sh                     # 部署 Pages
#   bash ops/upload.sh --commit --push     # 提交并推送
#   bash ops/upload.sh --all               # 提交 + 推送 + 部署 Pages
#   bash ops/upload.sh --worker=status-worker
#
# 凭据从本机 secrets/webauthn.env 读，不落盘、不回显。

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
        --help|-h) sed -n '20,31p' "$0"; exit 0 ;;
        *)
            echo "FATAL: 未知参数 $1" >&2
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

# ── ③ Pages：吞掉冗长日志，只在失败时吐出来 ─────────────────────────
if [ "$DO_PAGES" = 1 ]; then
    log="$(mktemp -t limooo-upload-XXXXXX.log)"
    trap 'rm -f "$log"' EXIT
    if bash ops/pages_deploy.sh >"$log" 2>&1; then
        # 只透传关键状态行，其余（构建清单、wrangler 上传进度）丢弃
        grep -E '^\[pages\] (产物|/_health|完成)' "$log" || true
        echo "Pages: done"
    else
        echo "Pages: FAILED — 完整日志如下" >&2
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
        echo "Worker: $WORKER FAILED — 完整日志如下" >&2
        cat "$log" >&2
        exit 1
    fi
fi

echo "Deploy: done"
