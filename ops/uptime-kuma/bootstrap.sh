#!/usr/bin/env bash

# Uptime Kuma 首次初始化的宿主侧入口。
# 只做三件事：生成/读取本地凭据、把 init.js 送进容器、把 push URL 写回 secrets。

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/uptime-kuma}"
REMOTE_SECRET="${REMOTE_SECRET:-/var/www/limooo/secrets/uptime-kuma.env}"
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=10)
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_INIT="$LOCAL_DIR/init.js"

echo "[kuma-init] 1/3 准备管理账号凭据（仅服务器 secrets，不进 git）"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    install -d -m 0700 \$(dirname '$REMOTE_SECRET')
    if [ ! -f '$REMOTE_SECRET' ]; then
        umask 077
        printf 'KUMA_ADMIN_USERNAME=Lime\n' > '$REMOTE_SECRET'
        printf 'KUMA_ADMIN_PASSWORD=%s\n' \"\$(openssl rand -base64 24 | tr -d '\\n')\" >> '$REMOTE_SECRET'
        chmod 600 '$REMOTE_SECRET'
    fi
"

REMOTE_USERNAME="$(ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "sed -n 's/^KUMA_ADMIN_USERNAME=//p' '$REMOTE_SECRET' | tail -1 | tr -d '\r'")"
REMOTE_PASSWORD="$(ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "sed -n 's/^KUMA_ADMIN_PASSWORD=//p' '$REMOTE_SECRET' | tail -1 | tr -d '\r'")"

if [ -z "$REMOTE_USERNAME" ] || [ -z "$REMOTE_PASSWORD" ]; then
    echo "FATAL: 未能读取 $REMOTE_SECRET 中的管理账号" >&2
    exit 2
fi

echo "[kuma-init] 2/3 送 init.js 进容器并执行"
scp "${SSH_OPTS[@]}" "$LOCAL_INIT" "$REMOTE_HOST:$REMOTE_ROOT/init.js"
INIT_OUTPUT="$(ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    docker cp '$REMOTE_ROOT/init.js' uptime-kuma:/app/init.js
    docker exec \
        -e KUMA_ADMIN_USERNAME='$REMOTE_USERNAME' \
        -e KUMA_ADMIN_PASSWORD='$REMOTE_PASSWORD' \
        uptime-kuma node /app/init.js
" )"
printf '%s\n' "$INIT_OUTPUT"
PUSH_URL="$(printf '%s\n' "$INIT_OUTPUT" | sed -n 's/^KUMA_PUSH_URL=//p' | tail -1 | tr -d '\r')"

echo "[kuma-init] 3/3 保存 push URL"
if [ -z "$PUSH_URL" ]; then
    echo "FATAL: init.js 未输出 KUMA_PUSH_URL" >&2
    exit 2
fi
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    umask 077
    if grep -q '^KUMA_PUSH_URL=' '$REMOTE_SECRET'; then
        python3 - '$REMOTE_SECRET' '$PUSH_URL' <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
url = sys.argv[2]
text = path.read_text(encoding='utf-8')
lines = text.splitlines(keepends=True)
out = []
seen = False
for line in lines:
    if line.startswith('KUMA_PUSH_URL='):
        out.append(f'KUMA_PUSH_URL={url}\n')
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(f'KUMA_PUSH_URL={url}\n')
path.write_text(''.join(out), encoding='utf-8')
PY
    else
        printf 'KUMA_PUSH_URL=%s\n' '$PUSH_URL' >> '$REMOTE_SECRET'
    fi
    chmod 600 '$REMOTE_SECRET'
"
