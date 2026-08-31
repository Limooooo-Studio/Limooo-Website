#!/usr/bin/env bash

# Limooo - Cloudflare Pages 构建与部署辅助脚本
#
# 与旧版的主要差异：
# - 固定使用仓库根 package.json 中锁定的 wrangler，不再 npx @latest。
# - 支持 --dry-run / --build-only：默认不写 Cloudflare，构建和部署可分离。
# - 部署前校验配置契约、生成 manifest，并检查 D1 schema。
# - 不自动 commit / push（由 ops/deploy.sh 单独控制）。

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/limooo}"
SSH_OPTS="-o LogLevel=ERROR -o ConnectTimeout=10"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAGES_PROJECT="${PAGES_PROJECT:-limooo}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"

VERBOSE=0
DRY_RUN=0
BUILD_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --verbose) VERBOSE=1 ;;
        --dry-run) DRY_RUN=1 ;;
        --build-only|--no-deploy) BUILD_ONLY=1 ;;
        *)
            echo "FATAL: unknown argument $1 (supported: --verbose / --dry-run / --build-only)" >&2
            exit 2
            ;;
    esac
    shift
done

cd "$LOCAL_DIR"

if [ "$DRY_RUN" = 1 ]; then
    echo "[pages] DRY-RUN: not writing to Cloudflare, no build/deploy."
    echo "[pages] will run: npm ci (root + ops) -> ops/build.sh -> ops/check_config_contract.py ->"
    echo "[pages]           ops/migrate_d1.sh --dry-run → npx wrangler pages deploy"
    echo "[pages] will-run: npm ci"
    echo "[pages] will-run: bash ops/build.sh"
    echo "[pages] will-run: bash ops/migrate_d1.sh --dry-run"
    echo "[pages] will-run: npx wrangler pages deploy public --project-name $PAGES_PROJECT --branch $PAGES_BRANCH"
    echo "[pages] dry-run complete (no server credentials read, no Cloudflare connection)."
    exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "FATAL: npm not found locally; cannot install locked frontend/CLI dependencies" >&2
    exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
    echo "FATAL: npx not found locally" >&2
    exit 1
fi

echo "[pages] Installing locked Node dependencies (root + ops)"
(cd "$LOCAL_DIR" && npm ci)
(cd "$LOCAL_DIR/ops" && npm ci)

if [ ! -x "$LOCAL_DIR/node_modules/.bin/wrangler" ]; then
    echo "FATAL: local wrangler not found; run npm ci first" >&2
    exit 1
fi

echo "[pages] Running reproducible build (build.sh)"
bash ops/build.sh

if [ ! -f "$LOCAL_DIR/public/manifest.json" ]; then
    echo "FATAL: public/manifest.json not generated after build" >&2
    exit 1
fi
echo "[pages] manifest: $(wc -c < "$LOCAL_DIR/public/manifest.json" | tr -d ' ') bytes"

if [ "$BUILD_ONLY" = 1 ]; then
    echo "[pages] Build complete (--build-only), skipping Pages deploy and D1 precheck."
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

echo "[pages] D1 schema precheck (read-only)"
bash ops/migrate_d1.sh --check-schema --remote

echo "[pages] npx wrangler pages deploy ..."
npx --no-install wrangler pages deploy public \
    --project-name "$PAGES_PROJECT" \
    --branch "$PAGES_BRANCH"
echo "Pages: done"
