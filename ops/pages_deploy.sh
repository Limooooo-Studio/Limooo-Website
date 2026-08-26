#!/bin/bash

# Limooo - Cloudflare Pages 部署辅助脚本
#
# auth.limooo.cn / limooo.cn 等站点由 Cloudflare Pages 托管（DNS 直接
# CNAME 到 limooo.pages.dev），VPS 的 rsync 部署不影响它们。因此 deploy.sh /
# upload.sh 在部署 VPS 之后必须再部署一次 Pages，改动才会真正上线。
#
# Cloudflare API token 不写入仓库：从服务器 secrets/webauthn.env 读取
# （服务器上 auto_block.py 的 IP List 同步已在用同一份凭据）。

set -e

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/limooo}"
SSH_OPTS="-o LogLevel=ERROR -o ConnectTimeout=10"
# ops/../ = Flask/（脚本可被 ops/deploy.sh / ops/upload.sh 以相对路径调用）
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

if ! ssh $SSH_OPTS "$REMOTE_HOST" "test -f $REMOTE_DIR/secrets/webauthn.env"; then
    echo "FATAL: 服务器缺少 $REMOTE_DIR/secrets/webauthn.env，无法获取 Cloudflare token" >&2
    exit 1
fi

# 从服务器读取 token 到当前 shell 环境（不落盘、不回显）
# 注意：macOS 自带 bash 3.2 的 source <(ssh ...) 有兼容问题，这里用 eval
eval "$(ssh $SSH_OPTS "$REMOTE_HOST" "cat $REMOTE_DIR/secrets/webauthn.env")"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "FATAL: webauthn.env 里没有 CLOUDFLARE_API_TOKEN" >&2
    exit 1
fi

# 配置契约一致性校验：contract / src/config.py / generated config.ts 不一致时禁止构建
if ! python3 ops/check_config_contract.py; then
    echo "FATAL: 跨端配置契约校验失败，已停止部署" >&2
    exit 1
fi

# ── Tailwind CSS 可复现构建 ──
# 优先按锁定版本重新生成；若服务器没有 node/npm，则回退到已提交的成品 CSS。
if command -v npm >/dev/null 2>&1; then
    echo "Tailwind: 安装锁定依赖并重新编译..."
    (cd ops && npm ci --silent)
    (cd ops && npm run build:css)
else
    echo "WARNING: 未找到 npm，跳过 Tailwind 重编译，使用已提交的 src/static/tailwind.css" >&2
fi

# ── 自动构建 Pages 静态产物（改了主站模板无需手动 build） ──
# 首次运行自动创建本地构建环境 .venv-build/（已 gitignore），装齐 Flask 依赖
BUILD_PY=".venv-build/bin/python"
if [ ! -x "$BUILD_PY" ]; then
    echo "首次构建：创建 .venv-build 并安装依赖..."
    python3 -m venv .venv-build
    .venv-build/bin/pip install -q -r ops/requirements.txt
fi
if [ "$VERBOSE" = 1 ]; then
    echo "$BUILD_PY src/build.py"
fi
DEPLOY_LOG="$(mktemp)"
if [ "$VERBOSE" = 1 ]; then
    "$BUILD_PY" src/build.py
else
    "$BUILD_PY" src/build.py >"$DEPLOY_LOG" 2>&1 || {
        echo "构建失败：" >&2
        cat "$DEPLOY_LOG" >&2
        rm -f "$DEPLOY_LOG"
        exit 1
    }
fi

# 生成 functions/_lib/config.ts 后再校验两端配置契约，避免部署不一致产物
python3 ops/check_config_contract.py

if [ "$VERBOSE" = 1 ]; then
    echo "npx -y wrangler@latest pages deploy public --project-name $PAGES_PROJECT --branch $PAGES_BRANCH"
fi
if [ "$VERBOSE" = 1 ]; then
    npx -y wrangler@latest pages deploy public --project-name "$PAGES_PROJECT" --branch "$PAGES_BRANCH"
else
    npx -y wrangler@latest pages deploy public --project-name "$PAGES_PROJECT" --branch "$PAGES_BRANCH" >>"$DEPLOY_LOG" 2>&1 || {
        echo "Pages 部署失败：" >&2
        cat "$DEPLOY_LOG" >&2
        rm -f "$DEPLOY_LOG"
        exit 1
    }
fi
rm -f "$DEPLOY_LOG"
echo "Pages: done"
