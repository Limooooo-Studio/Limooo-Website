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
            echo "FATAL: unknown argument $1 (supported: --dry-run / --worker=name)" >&2
            exit 2
            ;;
    esac
    shift
done

if [ ! -x "$ROOT/node_modules/.bin/wrangler" ]; then
    echo "FATAL: local wrangler not found, run npm ci in $ROOT first" >&2
    exit 1
fi

if ! command -v git >/dev/null 2>&1; then
    echo "FATAL: git is required to record the current commit" >&2
    exit 1
fi

COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')"

printf '%-24s %s %s\n' "commit" "$COMMIT" "dirty_files=$DIRTY"

WORKERS=("$ROOT/ops/sync-worker" "$ROOT/ops/image-watermark" "$ROOT/ops/d1-archive" "$ROOT/ops/status-worker")
if [ -n "$SELECTED" ]; then
    case "$SELECTED" in
        sync-worker) WORKERS=("$ROOT/ops/sync-worker") ;;
        image-watermark) WORKERS=("$ROOT/ops/image-watermark") ;;
        d1-archive) WORKERS=("$ROOT/ops/d1-archive") ;;
        status-worker) WORKERS=("$ROOT/ops/status-worker") ;;
        *) echo "FATAL: unknown Worker ${SELECTED} (available: sync-worker / image-watermark / d1-archive / status-worker)" >&2; exit 2 ;;
    esac
fi

# wrangler 自己会往输出里塞 emoji；这里只把 emoji 过滤掉，其余输出原样保留。
strip_emoji() {
    perl -CSD -pe 's/[\x{1F000}-\x{1FAFF}\x{2705}\x{274C}\x{26A0}\x{26C5}\x{2728}\x{2B50}][\x{FE0F}\x{200D}]*\h?//g'
}

for dir in "${WORKERS[@]}"; do
    name="$(basename "$dir")"
    config="$dir/wrangler.toml"
    if [ ! -f "$config" ]; then
        echo "FATAL: missing $config" >&2
        exit 1
    fi
    echo "[workers] $name -> wrangler deploy --config $config"
    if [ "$DRY_RUN" = 1 ]; then
        echo "  [dry-run] would run: (cd $dir && npx --no-install wrangler deploy)"
        continue
    fi
    (cd "$dir" && npx --no-install wrangler deploy 2>&1 | strip_emoji)
done

echo "[workers] done"
