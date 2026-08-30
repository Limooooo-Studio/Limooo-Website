#!/usr/bin/env bash

# Limooo - 部署 Uptime Kuma 到 admin.limooo.cn
#
# 说明：
# - 数据目录固定为 /opt/uptime-kuma/data，删除容器不会删除数据。
# - 容器只绑定 127.0.0.1:3001，Nginx 通过 HTTPS 反代。
# - 本脚本只负责 Kuma 与 admin 域名 Nginx 配置，不触碰 Flask/Pages 业务。

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/uptime-kuma}"
IMAGE="louislam/uptime-kuma:2.5.3"
CONTAINER="uptime-kuma"
NOW="$(date '+%Y%m%d-%H%M%S')"
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=10)
LOCAL_OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_COMPOSE="$LOCAL_OPS_DIR/uptime-kuma/compose.yaml"
LOCAL_SKIN="$LOCAL_OPS_DIR/uptime-kuma/kuma-admin-skin.css"
LOCAL_DIST="$LOCAL_OPS_DIR/uptime-kuma/kuma-dist"
LOCAL_NGINX="$LOCAL_OPS_DIR/limooo.conf"
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
    echo "[uptime-kuma] DRY-RUN：不连接服务器、不创建容器、不改 Nginx。"
    echo "[uptime-kuma] will-run: ssh $REMOTE_HOST mkdir -p $REMOTE_ROOT/data"
    echo "[uptime-kuma] will-run: scp compose.yaml -> $REMOTE_HOST:$REMOTE_ROOT/compose.yaml"
    echo "[uptime-kuma] will-run: scp kuma-admin-skin.css -> $REMOTE_HOST:$REMOTE_ROOT/kuma-admin-skin.css"
    echo "[uptime-kuma] will-run: rsync kuma-dist/ -> $REMOTE_HOST:$REMOTE_ROOT/dist/"
    echo "[uptime-kuma] will-run: docker pull $IMAGE"
    echo "[uptime-kuma] will-run: docker run -d --name $CONTAINER ... -p 127.0.0.1:3001:3001 -v $REMOTE_ROOT/data:/app/data $IMAGE"
    echo "[uptime-kuma] will-run: scp $LOCAL_NGINX -> /etc/nginx/conf.d/limooo.conf"
    echo "[uptime-kuma] will-run: nginx -t && systemctl reload nginx"
    exit 0
fi

if [ ! -f "$LOCAL_COMPOSE" ]; then
    echo "FATAL: 找不到 compose.yaml: $LOCAL_COMPOSE" >&2
    exit 2
fi
if [ ! -f "$LOCAL_SKIN" ]; then
    echo "FATAL: 找不到 kuma-admin-skin.css: $LOCAL_SKIN" >&2
    exit 2
fi
if [ ! -d "$LOCAL_DIST" ] || [ ! -f "$LOCAL_DIST/index.html" ]; then
    echo "FATAL: 找不到构建产物 kuma-dist/index.html: $LOCAL_DIST" >&2
    exit 2
fi
if [ ! -f "$LOCAL_NGINX" ]; then
    echo "FATAL: 找不到 nginx 配置: $LOCAL_NGINX" >&2
    exit 2
fi

echo "[uptime-kuma] 1/6 创建远端数据目录"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "install -d -m 0755 '$REMOTE_ROOT/data'"

echo "[uptime-kuma] 2/6 同步 compose.yaml、品牌皮肤与 fork dist"
scp "${SSH_OPTS[@]}" "$LOCAL_COMPOSE" "$REMOTE_HOST:$REMOTE_ROOT/compose.yaml"
scp "${SSH_OPTS[@]}" "$LOCAL_SKIN" "$REMOTE_HOST:$REMOTE_ROOT/kuma-admin-skin.css"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "chmod 0644 '$REMOTE_ROOT/kuma-admin-skin.css'"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "install -d -m 0755 '$REMOTE_ROOT/dist'"
rsync -a --delete "$LOCAL_DIST/" "$REMOTE_HOST:$REMOTE_ROOT/dist/"

echo "[uptime-kuma] 3/6 拉取固定镜像 $IMAGE"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "docker pull '$IMAGE'"

echo "[uptime-kuma] 4/6 重新创建容器（不重建镜像，数据目录保持不变）"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    docker network inspect authentik_default >/dev/null 2>&1 || docker network create authentik_default
    if docker inspect '$CONTAINER' >/dev/null 2>&1; then
        docker rm -f '$CONTAINER' >/dev/null
    fi
    docker run -d \
        --name '$CONTAINER' \
        --restart=unless-stopped \
        --memory=512m \
        --memory-swap=512m \
        -e TZ=Asia/Shanghai \
        -p 127.0.0.1:3001:3001 \
        --network authentik_default \
        -v '$REMOTE_ROOT/data:/app/data' \
        -v '$REMOTE_ROOT/dist:/app/dist' \
        --label com.limooo.service=uptime-kuma \
        --label com.limooo.domain=admin.limooo.cn \
        '$IMAGE'
"

echo "[uptime-kuma] 5/6 更新 admin.limooo.cn Nginx 配置"
scp "${SSH_OPTS[@]}" "$LOCAL_NGINX" "$REMOTE_HOST:/tmp/limooo.conf.$NOW"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    set -e
    install -m 0644 /tmp/limooo.conf.$NOW /etc/nginx/conf.d/limooo.conf
    rm -f /tmp/limooo.conf.$NOW
    nginx -t
    systemctl reload nginx
"

echo "[uptime-kuma] 6/6 等待服务就绪并检查"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15'
    for i in \$(seq 1 20); do
        if curl -fsSL -A \"\$UA\" --max-time 10 http://127.0.0.1:3001/api/entry-page >/dev/null 2>&1; then
            break
        fi
        sleep 2
    done
    docker ps --filter name='^$CONTAINER$' --format 'status={{.Status}} ports={{.Ports}}'
    curl -fsSL -A \"\$UA\" --max-time 15 http://127.0.0.1:3001/api/entry-page >/dev/null && echo 'local http: OK'
    PUBLIC_HEALTH=\"\$(curl -sSL -A \"\$UA\" --max-time 15 -o /dev/null -w '%{http_code}' https://admin.limooo.cn/_health 2>/dev/null || true)\"
    if [ \"\$PUBLIC_HEALTH\" = \"200\" ]; then
        echo 'public https: OK'
    else
        echo \"public https: unexpected \$PUBLIC_HEALTH\" >&2
        exit 1
    fi
"
