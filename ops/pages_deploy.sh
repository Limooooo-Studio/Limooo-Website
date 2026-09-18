#!/usr/bin/env bash

# Limooo - Cloudflare Pages 构建与部署（docs/17 零 VPS 版）
#
# 2026-09-17 起已退租 VPS：没有 ssh、没有远端 secrets、没有 rsync。
# 凭据只从本机 secrets/webauthn.env 读（该文件不入库），token 不落盘、不回显。
#
# 用法：
#   bash ops/pages_deploy.sh --dry-run      # 只打印将要做什么
#   bash ops/pages_deploy.sh --build-only   # 只构建 + 校验，不碰 Cloudflare
#   bash ops/pages_deploy.sh                # 构建 + 校验 + 部署 Pages + 冒烟
#
# 不自动 commit / push：那是 ops/deploy.sh 的职责。
#
# 本机仓库在 iCloud 同步区，仓库内 node_modules / .venv-build 不可用；
# 用 /tmp 下的 wrangler 与 venv（见 docs/18-resume.md）。

set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAGES_PROJECT="${PAGES_PROJECT:-limooo}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"
SECRETS_FILE="${SECRETS_FILE:-$LOCAL_DIR/secrets/webauthn.env}"

# iCloud 同步区里读大量小文件会卡死；用 /tmp 的隔离构建目录。
PUBLIC_DIR="${LIMOOO_PUBLIC_DIR:-/tmp/limooo-public}"
PREVIEW_DIR="${LIMOOO_PREVIEW_DIR:-/tmp/limooo-preview}"
VENV_PYTHON="${LIMOOO_VENV_PYTHON:-/tmp/limooo-venv/bin/python}"
WRANGLER_BIN="${WRANGLER_BIN:-/tmp/wrangler-env/node_modules/.bin/wrangler}"

DRY_RUN=0
BUILD_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --build-only|--no-deploy) BUILD_ONLY=1 ;;
        --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
        *)
            echo "FATAL: 未知参数 $1（支持 --dry-run / --build-only）" >&2
            exit 2
            ;;
    esac
    shift
done

cd "$LOCAL_DIR"

if [ "$DRY_RUN" = 1 ]; then
    echo "[pages] DRY-RUN：不构建、不写 Cloudflare。"
    echo "[pages] will-run: $VENV_PYTHON src/build.py   (PUBLIC_DIR=$PUBLIC_DIR)"
    echo "[pages] will-run: check_config_contract.py + check_security_headers.py"
    echo "[pages] will-run: $WRANGLER_BIN pages deploy $PUBLIC_DIR --project-name $PAGES_PROJECT --branch $PAGES_BRANCH"
    echo "[pages] 凭据来源：${SECRETS_FILE}（只读 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）"
    exit 0
fi

# ── 构建 ────────────────────────────────────────────────────────────
if [ ! -x "$VENV_PYTHON" ]; then
    echo "FATAL: 未找到构建 venv：$VENV_PYTHON" >&2
    echo "       重建：python3 -m venv /tmp/limooo-venv && /tmp/limooo-venv/bin/pip install -r ops/requirements.txt" >&2
    exit 1
fi

echo "[pages] 构建（隔离输出：${PUBLIC_DIR}）"
LIMOOO_PUBLIC_DIR="$PUBLIC_DIR" LIMOOO_PREVIEW_DIR="$PREVIEW_DIR" "$VENV_PYTHON" src/build.py

if [ ! -f "$PUBLIC_DIR/manifest.json" ]; then
    echo "FATAL: 构建后缺少 $PUBLIC_DIR/manifest.json" >&2
    exit 1
fi
echo "[pages] 产物 $(find "$PUBLIC_DIR" -type f | wc -l | tr -d ' ') 个文件"

# ── 部署前校验 ──────────────────────────────────────────────────────
echo "[pages] 契约与安全头校验"
"$VENV_PYTHON" ops/check_config_contract.py
python3 ops/check_security_headers.py

if [ "$BUILD_ONLY" = 1 ]; then
    echo "[pages] 构建完成（--build-only），跳过 Pages 部署。"
    exit 0
fi

# ── 凭据 ────────────────────────────────────────────────────────────
if [ ! -f "$SECRETS_FILE" ]; then
    echo "FATAL: 缺少 $SECRETS_FILE" >&2
    exit 1
fi
if [ ! -x "$WRANGLER_BIN" ]; then
    echo "FATAL: 未找到 wrangler：$WRANGLER_BIN" >&2
    echo "       重建：mkdir -p /tmp/wrangler-env && cd /tmp/wrangler-env && npm i wrangler@4" >&2
    exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    CLOUDFLARE_API_TOKEN="$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$SECRETS_FILE" | tail -1)"
    CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' "$SECRETS_FILE" | tail -1)"
    export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "FATAL: $SECRETS_FILE 里没有 CLOUDFLARE_API_TOKEN" >&2
    exit 1
fi

# ── 部署 ────────────────────────────────────────────────────────────
# 必须在本目录（Flask/）执行，否则 wrangler 找不到 functions/，会把整个
# Pages Functions 丢掉（docs/17 §11.6 出过这次事故）。
echo "[pages] 部署 Pages（务必在 Flask/ 下执行，否则丢失 Functions）"
export CI=1 WRANGLER_SEND_METRICS=false
"$WRANGLER_BIN" pages deploy "$PUBLIC_DIR" \
    --project-name "$PAGES_PROJECT" \
    --branch "$PAGES_BRANCH" \
    --commit-dirty=true

# ── 部署后冒烟 ──────────────────────────────────────────────────────
echo "[pages] 部署后校验"
health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://limooo.cn/_health || echo 000)"
if [ "$health" != "200" ]; then
    echo "FATAL: https://limooo.cn/_health = ${health}（期望 200）" >&2
    exit 1
fi
echo "[pages] /_health = 200 ✓"
echo "[pages] 完成。请确认上面的日志含 'Compiled Worker successfully' + 'Uploading Functions bundle'。"
