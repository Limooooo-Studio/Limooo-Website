#!/usr/bin/env bash

# Limooo - 作品集原图私有备份到 Cloudflare R2
#
# A2 之后，作品集完整原图（src/static/portfolio/*）不再随 Pages 发布，只在本地
# 与私有 R2 桶中留存（git 已忽略 src/static/portfolio/）。本脚本把原图上传到
# R2 私有桶 limooo-originals/portfolio/<file>，作为可审计、可回滚的备份。
#
# 用法：
#   bash ops/upload_originals.sh            # 上传（读服务器 secrets/webauthn.env 的 token）
#   bash ops/upload_originals.sh --dry-run # 只打印将执行的命令
#
# 凭据：CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 从服务器 secrets/webauthn.env
# 读取（与 pages_deploy.sh 同一份），不写入仓库。

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/limooo}"
SSH_OPTS="-o LogLevel=ERROR -o ConnectTimeout=10"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${R2_BUCKET:-limooo-originals}"
SOURCE_DIR="$LOCAL_DIR/src/static/portfolio"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$LOCAL_DIR"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "FATAL: missing $SOURCE_DIR" >&2
    exit 1
fi
if [ ! -x "$LOCAL_DIR/node_modules/.bin/wrangler" ]; then
    echo "FATAL: 未找到本地 wrangler，请先在 $LOCAL_DIR 执行 npm ci" >&2
    exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
    echo "[r2] DRY-RUN: 不会连接 Cloudflare。"
    echo "[r2] will-run: wrangler r2 bucket create ${BUCKET}  (若不存在)"
    echo "[r2] will-run: wrangler r2 object put ${BUCKET}/portfolio/<file> --file <file>"
    echo "[r2] files: $(find "$SOURCE_DIR" -maxdepth 1 -type f | wc -l | tr -d ' ')"
    exit 0
fi

if ! ssh $SSH_OPTS "$REMOTE_HOST" "test -f $REMOTE_DIR/secrets/webauthn.env"; then
    echo "FATAL: server missing $REMOTE_DIR/secrets/webauthn.env; cannot get Cloudflare token" >&2
    exit 1
fi
eval "$(ssh $SSH_OPTS "$REMOTE_HOST" "cat $REMOTE_DIR/secrets/webauthn.env")"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "FATAL: webauthn.env has no CLOUDFLARE_API_TOKEN" >&2
    exit 1
fi

echo "[r2] ensuring bucket $BUCKET exists"
if npx --no-install wrangler r2 bucket list 2>/dev/null | grep -q "\\b$BUCKET\\b"; then
    echo "[r2] bucket already exists"
else
    npx --no-install wrangler r2 bucket create "$BUCKET"
fi

count=0
for f in "$SOURCE_DIR"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    key="${BUCKET}/portfolio/${name}"
    npx --no-install wrangler r2 object put "$key" --file "$f"
    count=$((count + 1))
done
echo "[r2] uploaded $count originals to $BUCKET"
