#!/usr/bin/env bash

# Limooo - 单入口 Authentik 管理后台部署
#
# 职责（幂等）：
# 1. 把 Authentik 自身 URL 固定到 admin.limooo.cn；
# 2. 把 Proxy Provider 切换为 forward_single，由 Nginx 做 auth_request；
# 3. 同步自定义 if/admin.html（Authentik 管理页内嵌 Uptime Kuma）；
# 4. 重启 Authentik server/worker，并在等待就绪后校验 Nginx。
#
# 不修改 Cloudflare DNS（单入口由 ops 外步骤/控制台负责）；Nginx 仅保留
# identity.limooo.cn 的兼容 301。

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=10)
LOCAL_OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_TEMPLATE="$LOCAL_OPS_DIR/authentik/if/admin.html"
REMOTE_AUTHENTIK_DIR="/opt/authentik"
REMOTE_TEMPLATE_DIR="$REMOTE_AUTHENTIK_DIR/custom-templates/if"
REMOTE_NGINX="/etc/nginx/conf.d/limooo.conf"
DRY_RUN=0

for arg in "$@"; do
    case "$arg" in
        --dry-run)
            DRY_RUN=1
            ;;
        *)
            echo "FATAL: 未知参数 $arg（支持 --dry-run）" >&2
            exit 2
            ;;
    esac
done

if [ "$DRY_RUN" = 1 ]; then
    echo "[authentik] DRY-RUN：不会连接服务器。"
    echo "[authentik] will-run: 备份 remote docker-compose.yml / custom-templates"
    echo "[authentik] will-run: 更新 AUTHENTIK_URL -> https://admin.limooo.cn"
    echo "[authentik] will-run: PATCH Proxy Provider -> forward_single"
    echo "[authentik] will-run: PATCH Embedded Outpost authentik_host -> https://admin.limooo.cn"
    echo "[authentik] will-run: scp admin.html -> $REMOTE_TEMPLATE_DIR/admin.html"
    echo "[authentik] will-run: docker-compose up -d server worker"
    echo "[authentik] will-run: nginx -t && systemctl reload nginx"
    exit 0
fi

if [ ! -f "$LOCAL_TEMPLATE" ]; then
    echo "FATAL: 找不到 Authentik 管理模板: $LOCAL_TEMPLATE" >&2
    exit 2
fi

echo "[authentik] 1/6 备份远端配置"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    cp '$REMOTE_AUTHENTIK_DIR/docker-compose.yml' '$REMOTE_AUTHENTIK_DIR/docker-compose.yml.bak.single-admin-\$(date +%Y%m%d-%H%M%S)'
    if [ -f '$REMOTE_TEMPLATE_DIR/admin.html' ]; then
        cp '$REMOTE_TEMPLATE_DIR/admin.html' '$REMOTE_TEMPLATE_DIR/admin.html.bak.single-admin-\$(date +%Y%m%d-%H%M%S)'
    fi
"

echo "[authentik] 2/6 更新 Authentik URL"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "python3 - <<'PY'
from pathlib import Path
p = Path('$REMOTE_AUTHENTIK_DIR/docker-compose.yml')
text = p.read_text()
text = text.replace('AUTHENTIK_URL: https://identity.limooo.cn', 'AUTHENTIK_URL: https://admin.limooo.cn')
text = text.replace('AUTHENTIK_URL: https://identity.limooo.cn/', 'AUTHENTIK_URL: https://admin.limooo.cn/')
p.write_text(text)
PY"

echo "[authentik] 3/6 更新 Proxy Provider / Embedded Outpost"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    TOKEN=\$(cat '$REMOTE_AUTHENTIK_DIR/.bootstrap_token')
    curl -fsS -X PATCH \
        -H \"Authorization: Bearer \$TOKEN\" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        -d '{\"mode\":\"forward_single\",\"internal_host\":\"\"}' \
        http://127.0.0.1:9000/api/v3/providers/proxy/2/ >/dev/null
    OUTPOST_PK=\$(curl -fsS \
        -H \"Authorization: Bearer \$TOKEN\" \
        -H 'Accept: application/json' \
        http://127.0.0.1:9000/api/v3/outposts/instances/ | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"results\"][0][\"pk\"])')
    curl -fsS -X PATCH \
        -H \"Authorization: Bearer \$TOKEN\" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        -d '{\"config\":{\"authentik_host\":\"https://admin.limooo.cn\",\"authentik_host_browser\":\"https://admin.limooo.cn\",\"authentik_host_insecure\":false}}' \
        \"http://127.0.0.1:9000/api/v3/outposts/instances/\$OUTPOST_PK/\" >/dev/null
"

echo "[authentik] 4/6 同步管理模板"
scp "${SSH_OPTS[@]}" "$LOCAL_TEMPLATE" "$REMOTE_HOST:$REMOTE_TEMPLATE_DIR/admin.html"

echo "[authentik] 5/6 重启 Authentik"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    cd '$REMOTE_AUTHENTIK_DIR'
    if command -v docker-compose >/dev/null 2>&1; then
        docker-compose -f docker-compose.yml up -d server worker
    else
        docker restart authentik_server_1 authentik_worker_1 >/dev/null
    fi
"

echo "[authentik] 6/6 校验服务与 Nginx"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    for i in \$(seq 1 30); do
        if curl -fsS --max-time 2 http://127.0.0.1:9000/-/health/live/ >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    nginx -t
    systemctl reload nginx
    echo 'authentik single-admin deploy: OK'
"
