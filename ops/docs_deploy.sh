#!/usr/bin/env bash

# Limooo - docs.limooo.cn build and deploy (VitePress)
#
# Content lives in Flask/docs/*.md; every markdown file becomes
# https://docs.limooo.cn/<path>. The VitePress implementation is the fork at
# Limooooo-Studio/vitepress, so that header / footer changes in the fork show up
# on the next deploy.
#
# The fork has no published dist, so this script clones it into a cache dir,
# builds it with pnpm + tsdown and packs it into a tarball. The tarball is cached
# by commit sha: the fork is only rebuilt when LIMOOO_VITEPRESS_REF moves.
#
# The docs site is its own Cloudflare Pages project (default: limooo-docs), so a
# heavy VitePress build never touches the main limooo Pages artifact.
#
# Usage:
#   bash ops/docs_deploy.sh --dry-run      # print the plan only
#   bash ops/docs_deploy.sh --build-only   # build + validate, no Cloudflare writes
#   bash ops/docs_deploy.sh                # build + validate + deploy + smoke test
#   bash ops/docs_deploy.sh --dev          # run the VitePress dev server
#
# Environment overrides:
#   LIMOOO_VITEPRESS_REF   git ref of the fork (default: main)
#   LIMOOO_VITEPRESS_DIR   fork checkout cache (default: /tmp/limooo-vitepress)
#   LIMOOO_DOCS_BUILD_DIR  build workspace   (default: /tmp/limooo-docs-build)
#   DOCS_PAGES_PROJECT     Pages project     (default: limooo-docs)
#   LIMOOO_SKIP_VITEPRESS_BUILD=1  reuse the cached tarball as-is

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$ROOT/docs"
SECRETS_FILE="${SECRETS_FILE:-$ROOT/secrets/webauthn.env}"

PAGES_PROJECT="${DOCS_PAGES_PROJECT:-limooo-docs}"
PAGES_BRANCH="${DOCS_PAGES_BRANCH:-main}"
DOCS_HOST="${DOCS_HOST:-docs.limooo.cn}"

VITEPRESS_REPO="${LIMOOO_VITEPRESS_REPO:-https://github.com/Limooooo-Studio/vitepress.git}"
VITEPRESS_REF="${LIMOOO_VITEPRESS_REF:-main}"
VITEPRESS_DIR="${LIMOOO_VITEPRESS_DIR:-/tmp/limooo-vitepress}"
BUILD_DIR="${LIMOOO_DOCS_BUILD_DIR:-/tmp/limooo-docs-build}"

SRC_DIR="$BUILD_DIR/src"
DIST_DIR="$SRC_DIR/.vitepress/dist"
TARBALL="$BUILD_DIR/vitepress.tgz"
SHA_MARKER="$BUILD_DIR/vitepress.sha"

PNPM_BIN="${PNPM_BIN:-pnpm}"
WRANGLER_BIN="${WRANGLER_BIN:-/tmp/wrangler-env/node_modules/.bin/wrangler}"

DRY_RUN=0
BUILD_ONLY=0
DEV=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --build-only|--no-deploy) BUILD_ONLY=1 ;;
        --dev) DEV=1 ;;
        --help|-h) sed -n '20,36p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1 (supported: --dry-run / --build-only / --dev)" >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$DRY_RUN" = 1 ]; then
    echo "[docs] DRY-RUN: no fork build, no VitePress build, no Cloudflare writes."
    echo "[docs] will-run: git clone/fetch $VITEPRESS_REPO ($VITEPRESS_REF) -> $VITEPRESS_DIR"
    echo "[docs] will-run: pnpm install && pnpm exec tsdown && pnpm pack -> $TARBALL (only when the fork commit changes)"
    echo "[docs] will-run: rsync $DOCS_DIR/ -> $SRC_DIR/ (exclude node_modules, .vitepress/dist)"
    echo "[docs] will-run: pnpm install && pnpm exec vitepress build . --outDir $DIST_DIR"
    echo "[docs] will-run: python3 ops/docs_headers.py $DIST_DIR"
    echo "[docs] will-run: $WRANGLER_BIN pages deploy $DIST_DIR --project-name $PAGES_PROJECT --branch $PAGES_BRANCH"
    exit 0
fi

if [ ! -d "$DOCS_DIR" ]; then
    echo "FATAL: docs source directory not found: $DOCS_DIR" >&2
    exit 1
fi

if ! command -v "$PNPM_BIN" >/dev/null 2>&1; then
    echo "FATAL: pnpm not found (needed to build the VitePress fork and the docs site)" >&2
    exit 1
fi

mkdir -p "$BUILD_DIR"

# ── ① 构建 fork（按 commit 缓存）────────────────────────────────────
ensure_vitepress() {
    if [ ! -d "$VITEPRESS_DIR/.git" ]; then
        echo "[docs] cloning VitePress fork: $VITEPRESS_REPO"
        rm -rf "$VITEPRESS_DIR"
        git clone --filter=blob:none --quiet "$VITEPRESS_REPO" "$VITEPRESS_DIR"
    fi

    echo "[docs] fetching VitePress fork: $VITEPRESS_REF"
    git -C "$VITEPRESS_DIR" fetch --quiet --depth 1 origin "$VITEPRESS_REF"
    git -C "$VITEPRESS_DIR" reset --hard --quiet FETCH_HEAD
    local sha
    sha="$(git -C "$VITEPRESS_DIR" rev-parse HEAD)"
    echo "[docs] VitePress fork commit: $sha"

    if [ "${LIMOOO_SKIP_VITEPRESS_BUILD:-0}" = 1 ] && [ -f "$TARBALL" ]; then
        echo "[docs] LIMOOO_SKIP_VITEPRESS_BUILD=1, reusing cached tarball"
        return 0
    fi
    if [ -f "$TARBALL" ] && [ "$(cat "$SHA_MARKER" 2>/dev/null || true)" = "$sha" ]; then
        echo "[docs] VitePress fork already built for this commit, reusing tarball"
        return 0
    fi

    echo "[docs] building VitePress fork (pnpm install + tsdown)"
    (
        cd "$VITEPRESS_DIR"
        "$PNPM_BIN" install --frozen-lockfile
        "$PNPM_BIN" exec tsdown
    )
    echo "[docs] packing VitePress fork"
    rm -f "$BUILD_DIR"/vitepress-*.tgz
    (
        cd "$VITEPRESS_DIR"
        "$PNPM_BIN" pack --pack-destination "$BUILD_DIR" >/dev/null
    )
    local packed
    packed="$(ls -t "$BUILD_DIR"/vitepress-*.tgz | head -n 1)"
    mv "$packed" "$TARBALL"
    printf '%s' "$sha" > "$SHA_MARKER"
    echo "[docs] tarball: $TARBALL"
}

ensure_vitepress

# ── ② 同步内容到构建工作区 ──────────────────────────────────────────
echo "[docs] syncing $DOCS_DIR -> $SRC_DIR"
mkdir -p "$SRC_DIR"
rsync -a --delete \
    --exclude '.DS_Store' \
    --exclude 'node_modules' \
    --exclude 'package.json' \
    --exclude 'pnpm-lock.yaml' \
    --exclude '.vitepress/cache' \
    --exclude '.vitepress/dist' \
    "$DOCS_DIR/" "$SRC_DIR/"

cat > "$SRC_DIR/package.json" <<JSON
{
  "name": "limooo-docs",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vitepress dev .",
    "build": "vitepress build .",
    "preview": "vitepress preview ."
  },
  "devDependencies": {
    "vitepress": "file:$TARBALL",
    "vue": "^3.5.42"
  }
}
JSON

echo "[docs] installing docs dependencies (vitepress from the fork tarball)"
(
    cd "$SRC_DIR"
    "$PNPM_BIN" install --no-frozen-lockfile --reporter=append-only
)

if [ "$DEV" = 1 ]; then
    echo "[docs] starting dev server"
    exec bash -c "cd '$SRC_DIR' && '$PNPM_BIN' exec vitepress dev . --host"
fi

# ── ③ 构建站点 ──────────────────────────────────────────────────────
echo "[docs] building docs site"
(
    cd "$SRC_DIR"
    "$PNPM_BIN" exec vitepress build . --outDir "$DIST_DIR"
)

# ── ④ 校验产物：每个 md 都要有对应 HTML ─────────────────────────────
echo "[docs] validating markdown -> html mapping"
missing=0
while IFS= read -r md; do
    rel="${md#"$DOCS_DIR"/}"
    case "$rel" in
        .vitepress/*|node_modules/*) continue ;;
    esac
    html="$DIST_DIR/${rel%.md}.html"
    if [ ! -f "$html" ]; then
        echo "  missing: ${rel%.md}.html" >&2
        missing=1
    fi
done < <(find "$DOCS_DIR" -name '*.md' -type f | sort)
if [ "$missing" = 1 ]; then
    echo "FATAL: docs build did not produce HTML for every markdown file" >&2
    exit 1
fi
echo "[docs] artifact: $(find "$DIST_DIR" -type f | wc -l | tr -d ' ') files"

python3 "$ROOT/ops/docs_headers.py" "$DIST_DIR"

if [ "$BUILD_ONLY" = 1 ]; then
    echo "[docs] build finished (--build-only), skipping Pages deploy."
    exit 0
fi

# ── ⑤ 凭据 ──────────────────────────────────────────────────────────
if [ ! -f "$SECRETS_FILE" ]; then
    echo "FATAL: missing $SECRETS_FILE" >&2
    exit 1
fi
if [ ! -x "$WRANGLER_BIN" ]; then
    echo "FATAL: wrangler not found: $WRANGLER_BIN" >&2
    echo "       recreate: mkdir -p /tmp/wrangler-env && cd /tmp/wrangler-env && npm i wrangler@4" >&2
    exit 1
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    CLOUDFLARE_API_TOKEN="$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$SECRETS_FILE" | tail -1)"
    CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' "$SECRETS_FILE" | tail -1)"
    export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi

# ── ⑥ 部署到 Pages ──────────────────────────────────────────────────
# 在 BUILD_DIR 下执行：避免 wrangler 向上找到 Flask/wrangler.toml 里主站项目的 name。
echo "[docs] deploying Pages project: $PAGES_PROJECT"
export CI=1 WRANGLER_SEND_METRICS=false
(
    cd "$BUILD_DIR"
    "$WRANGLER_BIN" pages deploy "$DIST_DIR" \
        --project-name "$PAGES_PROJECT" \
        --branch "$PAGES_BRANCH" \
        --commit-dirty=true
)

# ── ⑦ 冒烟 ──────────────────────────────────────────────────────────
echo "[docs] post-deploy check"
for path in / /video-platform /en-us/video-platform; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${DOCS_HOST}${path}" || echo 000)"
    if [ "$code" != "200" ]; then
        echo "FATAL: https://${DOCS_HOST}${path} = ${code} (expected 200)" >&2
        exit 1
    fi
    echo "[docs] ${path} = 200 OK"
done
echo "[docs] done."
