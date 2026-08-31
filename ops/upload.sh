#!/bin/bash

# Limooo - Flask Web Application
#
# Copyright (C) 2026 Limooo <https://limooo.cn/>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# limooo.cn 上传/部署脚本（独立完整版）
# 功能与 ops/deploy.sh 对齐（--dry-run/--commit/--push、nginx conf.d、密钥/生成物排除），
# 但输出刻意精简：成功时只打印一行行程式状态，build/pages 的冗长日志被吞掉。
#
# 换服务器：只需修改 REMOTE_HOST 为新的 IP/域名即可完整恢复
# 若提示 host key 冲突，先执行: ssh-keygen -R <REMOTE_HOST>

set -e

DRY_RUN=0
DO_COMMIT=1
DO_PUSH=1
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --commit) DO_COMMIT=1 ;;
        --push) DO_PUSH=1 ;;
        *)
            echo "FATAL: 未知参数 $arg（支持 --dry-run / --commit / --push）" >&2
            exit 2
            ;;
    esac
done

# Config（走 ~/.ssh/config 的 limooo 别名：IP/密钥/端口都在那里）
REMOTE_HOST="limooo"   # <-- 换服务器时改这里(改成新服务器的 ssh config 别名或 IP)
REMOTE_DIR="/var/www/limooo"
LOCAL_DIR="/Users/lime/Documents/Project/Limooo/Flask/"
SSH_OPTS="-o LogLevel=ERROR"

echo "Deploy start"

cd "$LOCAL_DIR" || { echo "FATAL: 本地目录不存在 $LOCAL_DIR"; exit 1; }

if [ "$DRY_RUN" = 1 ]; then
    echo "[deploy] DRY-RUN: 不 commit、不 push、不 SSH、不 rsync。"
    echo "[deploy] would-run: rsync -aqz --delete ... $REMOTE_HOST:$REMOTE_DIR"
    echo "[deploy] would-run: ssh $REMOTE_HOST (安装依赖 / systemd / nginx / cron)"
    echo "[deploy] would-run: bash ops/pages_deploy.sh --dry-run"
    bash ops/pages_deploy.sh --dry-run
    exit 0
fi

# 部署前提交/推送（默认不自动，需 --commit / --push，与 deploy.sh 一致）
if [ "$DO_COMMIT" = 1 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git add -A -- . ':!limooo.cn.png'
    if ! git diff --cached --quiet; then
        git commit -m "deploy: auto-commit $(date '+%Y-%m-%d %H:%M')" >/dev/null
        echo "Git: committed local changes"
    fi
fi
if [ "$DO_PUSH" = 1 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git push origin main >/dev/null 2>&1; then
        echo "Git: pushed to GitHub"
    else
        echo "Warning: git push failed, continuing deploy"
    fi
fi

# 先把服务器上的业务库(geo_cache.db 缓存 + appleid.db 账户)拉回本地覆盖,再推代码
# 这样本地始终保留服务器数据库的最新副本,且本地空库永远不会覆盖服务器
# 注意:远程 root 默认 shell 是 zsh,文件不存在的 glob 会报错,故 appleid.db 存在才拉
rsync -aqz -e "ssh $SSH_OPTS" "$REMOTE_HOST:$REMOTE_DIR/data/geo_cache.db*" data/
if ssh $SSH_OPTS $REMOTE_HOST "test -e $REMOTE_DIR/data/appleid.db"; then
    rsync -aqz -e "ssh $SSH_OPTS" "$REMOTE_HOST:$REMOTE_DIR/data/appleid.db*" data/
fi

rsync -aqz --delete -e "ssh $SSH_OPTS" \
    --exclude 'venv' \
    --exclude '__pycache__' \
    --exclude '.DS_Store' \
    --exclude '.git' \
    --exclude '.venv-build' \
    --exclude '.wrangler' \
    --exclude '.pytest_cache' \
    --exclude 'public/' \
    --exclude 'preview/' \
    --exclude 'deploy.sh' \
    --exclude 'upload.sh' \
    --exclude 'node_modules' \
    --exclude 'GeoLite2-City.mmdb' \
    --exclude 'GeoLite2-ASN.mmdb' \
    --exclude '.gitignore' \
    --exclude '.d1-migrations' \
    --exclude '.claude' \
    --exclude 'command.txt' \
    --exclude 'flask_secret.key' \
    --exclude 'appleid_encryption.key' \
    --exclude 'secrets/smtp-relay.env' \
    --exclude 'secrets/authentik-email.env' \
    --exclude 'secrets/uptime-kuma.env' \
    --exclude 'secrets/webauthn.env' \
    --exclude 'README 2.md' \
    --exclude 'geo_cache.db*' \
    --exclude 'appleid.db*' \
    --exclude 'auth.db*' \
    --exclude 'Logs' \
    --exclude 'limooo.cn.png' \
    --exclude 'limooo.pem' \
    --exclude '各种密钥.txt' \
    "$LOCAL_DIR" $REMOTE_HOST:$REMOTE_DIR

ssh $SSH_OPTS $REMOTE_HOST << 'EOF' 2>&1 | grep -vE "^Linux |^Debian |^Last login|Welcome to"
    set -e

    # ── 新服务器依赖：缺失则 apt 自动安装 ────────────────
    MISSING=""
    command -v rsync >/dev/null 2>&1 || MISSING="$MISSING rsync"
    command -v python3 >/dev/null 2>&1 || MISSING="$MISSING python3"
    command -v nginx >/dev/null 2>&1 || MISSING="$MISSING nginx"
    command -v ipset >/dev/null 2>&1 || MISSING="$MISSING ipset"
    if [ -n "$MISSING" ]; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx rsync python3 python3-venv python3-pip ipset
    fi
    # nginx 需带 http_v3 模块（HTTP/3/QUIC）；Debian 官方源 1.25+ 自带，缺失则视为未装好
    if ! nginx -V 2>&1 | grep -q http_v3_module; then
        echo "FATAL: nginx lacks http_v3_module — apt nginx should include it; check OS/nginx version"
        exit 1
    fi
    # docker 仅服务 authentik（/opt/authentik 单独部署），缺失则自动安装
    if ! command -v docker >/dev/null 2>&1; then
        apt-get install -y -qq docker.io
    fi

    cd /var/www/limooo

    find . -name "*.pyc" -delete 2>/dev/null || true
    find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

    if [ ! -d "venv" ]; then
        python3 -m venv venv
    fi
    ./venv/bin/pip install --upgrade pip -q
    ./venv/bin/pip install --upgrade -r ops/requirements.txt -q

    # Restore Cloudflare Origin CA certificates (nginx ssl_certificate points here)
    if [ ! -f "/etc/nginx/ssl/origin-cert.pem" ] && [ -f "/var/www/limooo/secrets/origin-cert.pem" ]; then
        mkdir -p /etc/nginx/ssl
        chmod 700 /etc/nginx/ssl
        cp /var/www/limooo/secrets/origin-cert.pem /etc/nginx/ssl/
        cp /var/www/limooo/secrets/origin-key.pem /etc/nginx/ssl/
        chmod 600 /etc/nginx/ssl/origin-cert.pem /etc/nginx/ssl/origin-key.pem
    fi

    # 密钥迁移到 /etc/limooo/(chmod 600),避免与密文同目录存放
    # 已有密钥原样保留(不覆盖),否则 session 失效、Apple ID 密码解不开
    sudo mkdir -p /etc/limooo
    sudo chmod 700 /etc/limooo
    for kf in flask_secret.key appleid_encryption.key; do
        if [ ! -f "/etc/limooo/$kf" ]; then
            if [ -f "secrets/$kf" ]; then
                sudo cp -p "secrets/$kf" "/etc/limooo/$kf"
            else
                sudo touch "/etc/limooo/$kf"   # 占位,由 Flask 首次启动生成
            fi
        fi
        sudo chmod 600 "/etc/limooo/$kf"
        # 迁移成功后清除项目目录残留密钥,避免与密文同目录
        if [ -f "secrets/$kf" ]; then
            rm -f "secrets/$kf"
        fi
    done

    sudo systemctl stop limooo 2>/dev/null || true
    # 只杀 Flask 自己的 gunicorn（按启动路径匹配），避免误杀 authentik 的 gunicorn
    sudo pkill -9 -f "/var/www/limooo/venv/bin/gunicorn" 2>/dev/null || true
    sleep 1

    # Remove corrupted geo_cache.db (0-byte file causes 500 error)
    if [ -f "data/geo_cache.db" ] && [ ! -s "data/geo_cache.db" ]; then
        rm -f data/geo_cache.db
    fi

    # Env file (secrets + API keys) — 通常由本地同步到 secrets/;缺失时兜底
    mkdir -p secrets
    if [ ! -f "secrets/webauthn.env" ]; then
        cat > secrets/webauthn.env << 'WEOF'
REST_COUNTRIES_KEY=rc_live_xxx_replace_with_real_key
GEONAMES_USERNAME=limooo
LIBRETRANSLATE_URL=
ENTRA_CLIENT_SECRET=
AUTHENTIK_CLIENT_ID=
AUTHENTIK_CLIENT_SECRET=
WEOF
    else
        grep -q '^REST_COUNTRIES_KEY=' secrets/webauthn.env || echo 'REST_COUNTRIES_KEY=rc_live_xxx_replace_with_real_key' >> secrets/webauthn.env
        grep -q '^GEONAMES_USERNAME=' secrets/webauthn.env || echo 'GEONAMES_USERNAME=limooo' >> secrets/webauthn.env
        grep -q '^LIBRETRANSLATE_URL=' secrets/webauthn.env || echo 'LIBRETRANSLATE_URL=' >> secrets/webauthn.env
        grep -q '^ENTRA_CLIENT_SECRET=' secrets/webauthn.env || echo 'ENTRA_CLIENT_SECRET=' >> secrets/webauthn.env
        grep -q '^AUTHENTIK_CLIENT_ID=' secrets/webauthn.env || echo 'AUTHENTIK_CLIENT_ID=' >> secrets/webauthn.env
        grep -q '^AUTHENTIK_CLIENT_SECRET=' secrets/webauthn.env || echo 'AUTHENTIK_CLIENT_SECRET=' >> secrets/webauthn.env
        grep -q '^AUTHENTIK_INTERNAL_URL=' secrets/webauthn.env || echo 'AUTHENTIK_INTERNAL_URL=http://127.0.0.1:9000' >> secrets/webauthn.env
    fi

    sudo cp ops/limooo.service /etc/systemd/system/limooo.service
    sudo systemctl daemon-reload
    sudo systemctl enable limooo >/dev/null 2>&1
    sudo systemctl start limooo
    sleep 2
    sudo systemctl is-active limooo | sed 's/^/limooo: /'

    # nginx 主配置只 include /etc/nginx/conf.d/*.conf,必须放到 conf.d/ 才会生效
    # (sites-available/ + sites-enabled/ 的旧做法从未被加载,已废弃)
    sudo install -d -m 0750 -o nginx -g nginx /var/cache/nginx/authentik 2>/dev/null || true
    sudo cp ops/limooo.conf /etc/nginx/conf.d/limooo.conf
    sudo rm -f /etc/nginx/sites-enabled/limooo.conf /etc/nginx/sites-available/limooo.conf
    sudo cp ops/location-security.inc /etc/nginx/conf.d/location-security.inc

    # Remove default site to avoid port conflicts
    if [ -f /etc/nginx/sites-enabled/default ]; then
        sudo rm /etc/nginx/sites-enabled/default
    fi

    if sudo nginx -t >/dev/null 2>&1; then
        sudo systemctl restart nginx
        echo "nginx: ok"
    else
        sudo nginx -t
        echo "FATAL: nginx 配置检查失败,中止部署"
        exit 1
    fi

    # Setup auto_block cron job (daily at 3:00 AM)
    if ! crontab -l 2>/dev/null | grep -q 'auto_block.py'; then
        (crontab -l 2>/dev/null; echo "0 3 * * * cd /var/www/limooo/src && ../venv/bin/python3 auto_block.py >> /var/log/auto_block.log 2>&1") | crontab -
    fi

    cd /var/www/limooo/src && ../venv/bin/python3 auto_block.py ipset >/dev/null 2>&1
EOF

# Cloudflare Pages 构建与部署（安静模式：成功只打印一行，失败才回显完整日志）
PAGES_LOG="$(mktemp "${TMPDIR:-/tmp}/limooo-pages.XXXXXX")"
if bash "$LOCAL_DIR/ops/pages_deploy.sh" >"$PAGES_LOG" 2>&1; then
    echo "Pages: done"
else
    echo "FATAL: Pages 部署失败，完整日志如下" >&2
    cat "$PAGES_LOG" >&2
    rm -f "$PAGES_LOG"
    exit 1
fi
rm -f "$PAGES_LOG"

echo "Deploy: done"
