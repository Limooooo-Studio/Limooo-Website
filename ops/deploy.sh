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

# limooo.cn 完整部署入口（docs/17 零 VPS 版）
#
# 2026-09-17 起已退租 VPS：没有 ssh、没有 rsync、没有远端重启、没有 nginx。
# 完整部署 = ① git commit → ② git push → ③ Cloudflare Pages（+ 相关 Worker）。
#
# 用法：
#   bash ops/deploy.sh --dry-run                # 只打印将要做什么
#   bash ops/deploy.sh --commit                 # 只提交
#   bash ops/deploy.sh --commit --push          # 提交并推送
#   bash ops/deploy.sh --all                    # 提交 + 推送 + 部署 Pages
#   bash ops/deploy.sh --worker=status-worker   # 只部署某个独立 Worker
#
# 不带任何参数时：只部署 Pages（不 commit / 不 push），保持旧脚本的手感。
# 凭据从本机 secrets/webauthn.env 读，不落盘、不回显；该文件不入库。

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
        --help|-h) sed -n '20,34p' "$0"; exit 0 ;;
        *)
            echo "FATAL: 未知参数 $1" >&2
            echo "       支持：--dry-run / --commit / --push / --pages / --all / --worker=<name>" >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$DO_COMMIT" = 0 ] && [ "$DO_PUSH" = 0 ] && [ "$DO_PAGES" = 0 ] && [ -z "$WORKER" ]; then
    DO_PAGES=1
fi

if [ "$DRY_RUN" = 1 ]; then
    echo "[deploy] DRY-RUN：不写 git、不写 Cloudflare。"
    [ "$DO_COMMIT" = 1 ] && echo "[deploy] will-run: git add -A && git commit"
    [ "$DO_PUSH" = 1 ] && echo "[deploy] will-run: git push origin main"
    [ "$DO_PAGES" = 1 ] && echo "[deploy] will-run: bash ops/pages_deploy.sh"
    [ -n "$WORKER" ] && echo "[deploy] will-run: bash ops/workers_deploy.sh --worker=$WORKER"
    exit 0
fi

# ── ① git commit ────────────────────────────────────────────────────
if [ "$DO_COMMIT" = 1 ]; then
    echo "[deploy] ① git commit"
    git add -A -- . ':!limooo.cn.png'
    if git diff --cached --quiet; then
        echo "[deploy] 没有需要提交的改动，跳过 commit"
    else
        git commit -m "deploy: $(date '+%Y-%m-%d %H:%M')"
    fi
fi

# ── ② git push ──────────────────────────────────────────────────────
if [ "$DO_PUSH" = 1 ]; then
    echo "[deploy] ② git push"
    git fetch origin main
    LOCAL_HEAD="$(git rev-parse HEAD)"
    REMOTE_HEAD="$(git rev-parse origin/main)"
    if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
        echo "[deploy] 与 origin/main 一致，无需 push"
    elif git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
        git push origin main
    else
        echo "FATAL: 本地与 origin/main 已分叉，请先手动处理（rebase/merge）" >&2
        exit 1
    fi
fi

# ── ③ Cloudflare Pages ──────────────────────────────────────────────
if [ "$DO_PAGES" = 1 ]; then
    echo "[deploy] ③ Cloudflare Pages"
    bash ops/pages_deploy.sh
fi

# ── 独立 Worker（可选，与 Pages 互不影响）────────────────────────────
if [ -n "$WORKER" ]; then
    echo "[deploy] Worker: $WORKER"
    bash ops/workers_deploy.sh "--worker=$WORKER"
fi

echo "[deploy] 完成。"
