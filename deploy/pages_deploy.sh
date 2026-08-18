#!/bin/bash

# Limooo - Cloudflare Pages 部署辅助脚本
#
# auth.limooo.cn / limooo.cn 等站点由 Cloudflare Pages 托管（DNS 直接
# CNAME 到 limooo.pages.dev），VPS 的 rsync 部署不影响它们。因此 deploy.sh /
# upload.sh 在部署 VPS 之后必须再部署一次 Pages，改动才会真正上线。
#
# Cloudflare API token 不写入仓库：从服务器 keys/webauthn.env 读取
# （服务器上 auto_block.py 的 IP List 同步已在用同一份凭据）。

set -e

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/limooo}"
SSH_OPTS="-o LogLevel=ERROR -o ConnectTimeout=10"
# deploy/../ = Flask/（脚本可被 deploy.sh / upload.sh 以相对路径调用）
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAGES_PROJECT="limooo"
PAGES_BRANCH="main"

VERBOSE=0
[ "$1" = "--verbose" ] && VERBOSE=1

cd "$LOCAL_DIR"

if ! command -v npx >/dev/null 2>&1; then
    echo "FATAL: 本地找不到 npx，无法部署 Cloudflare Pages" >&2
    exit 1
fi

if ! ssh $SSH_OPTS "$REMOTE_HOST" "test -f $REMOTE_DIR/keys/webauthn.env"; then
    echo "FATAL: 服务器缺少 $REMOTE_DIR/keys/webauthn.env，无法获取 Cloudflare token" >&2
    exit 1
fi

# 从服务器读取 token 到当前 shell 环境（不落盘、不回显）
# 注意：macOS 自带 bash 3.2 的 source <(ssh ...) 有兼容问题，这里用 eval
eval "$(ssh $SSH_OPTS "$REMOTE_HOST" "cat $REMOTE_DIR/keys/webauthn.env")"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "FATAL: webauthn.env 里没有 CLOUDFLARE_API_TOKEN" >&2
    exit 1
fi

# ── 自动构建 Pages 静态产物（改了主站模板无需手动 build） ──
# 首次运行自动创建本地构建环境 .venv-build/（已 gitignore），装齐 Flask 依赖
BUILD_PY=".venv-build/bin/python"
if [ ! -x "$BUILD_PY" ]; then
    echo "首次构建：创建 .venv-build 并安装依赖..."
    python3 -m venv .venv-build
    .venv-build/bin/pip install -q flask cryptography geoip2 certifi httpx requests aiohttp click pydantic msal
fi
if [ "$VERBOSE" = 1 ]; then
    echo "$BUILD_PY src/build.py"
fi
"$BUILD_PY" src/build.py

if [ "$VERBOSE" = 1 ]; then
    echo "npx -y wrangler@latest pages deploy public --project-name $PAGES_PROJECT --branch $PAGES_BRANCH"
fi
npx -y wrangler@latest pages deploy public --project-name "$PAGES_PROJECT" --branch "$PAGES_BRANCH"

echo "Pages: done"
