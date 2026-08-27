#!/usr/bin/env bash

# Limooo 独立 Worker 统一部署入口。
#
# 覆盖：
#   - ops/sync-worker       （D1 blocked_ips → Cloudflare IP List）
#   - ops/image-watermark   （image.limooo.cn 水印路由）
#
# 支持 --dry-run / --worker=<name>。凭据通过环境变量
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 注入，不写入仓库。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=0
SELECTED=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --worker=*) SELECTED="${1#--worker=}" ;;
        *)
            echo "FATAL: 未知参数 $1（支持 --dry-run / --worker=name）" >&2
            exit 2
            ;;
    esac
    shift
done

if [ ! -x "$ROOT/node_modules/.bin/wrangler" ]; then
    echo "FATAL: 未找到本地 wrangler，请先在 $ROOT 执行 npm ci" >&2
    exit 1
fi

if ! command -v git >/dev/null 2>&1; then
    echo "FATAL: 需要 git 来记录当前 commit" >&2
    exit 1
fi

COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')"

printf '%-24s %s %s\n' "commit" "$COMMIT" "dirty_files=$DIRTY"

WORKERS=("$ROOT/ops/sync-worker" "$ROOT/ops/image-watermark")
if [ -n "$SELECTED" ]; then
    case "$SELECTED" in
        sync-worker) WORKERS=("$ROOT/ops/sync-worker") ;;
        image-watermark) WORKERS=("$ROOT/ops/image-watermark") ;;
        *) echo "FATAL: 未知 Worker $SELECTED（可选 sync-worker / image-watermark）" >&2; exit 2 ;;
    esac
fi

for dir in "${WORKERS[@]}"; do
    name="$(basename "$dir")"
    config="$dir/wrangler.toml"
    if [ ! -f "$config" ]; then
        echo "FATAL: 缺少 $config" >&2
        exit 1
    fi
    echo "[workers] $name -> wrangler deploy --config $config"
    if [ "$DRY_RUN" = 1 ]; then
        echo "  [dry-run] would run: (cd $dir && npx --no-install wrangler deploy)"
        continue
    fi
    (cd "$dir" && npx --no-install wrangler deploy)
done

echo "[workers] done"
