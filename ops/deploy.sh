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

# limooo.cn 部署脚本 — 完整输出版本(无任何简略/静默输出)
# 与 upload.sh(旧版)逻辑一致,但所有命令输出完整显示:
#   不加 -q/-qq、不重定向 /dev/null、不省略日志
#   每个命令执行前直接回显命令本身,不写描述性别名
#
# 换服务器:只需修改 REMOTE_HOST 为新的 IP/域名即可完整恢复
# 若提示 host key 冲突,先执行: ssh-keygen -R <REMOTE_HOST>

set -e

# Config(走 ~/.ssh/config 的 limooo 别名:IP/密钥/端口都在那里)
REMOTE_HOST="limooo"   # <-- 换服务器时改这里(改成新服务器的 ssh config 别名或 IP)
REMOTE_DIR="/var/www/limooo"
LOCAL_DIR="/Users/lime/Documents/Project/Limooo/Flask/"
SSH_OPTS="-o LogLevel=ERROR"

echo "cd $LOCAL_DIR"
cd "$LOCAL_DIR" || { echo "FATAL: 本地目录不存在 $LOCAL_DIR"; exit 1; }

# 部署前自动提交本地改动到 GitHub(保持 GitHub 与服务器代码一致)
echo "git rev-parse --is-inside-work-tree"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "git add -A -- . ':!limooo.cn.png'"
    git add -A -- . ':!limooo.cn.png'
    if ! git diff --cached --quiet; then
        echo "git commit -m \"deploy: auto-commit $(date '+%Y-%m-%d %H:%M')\""
        git commit -m "deploy: auto-commit $(date '+%Y-%m-%d %H:%M')"
        echo "Git: committed local changes"
    fi
    echo "git push origin main"
    if git push origin main; then
        echo "Git: pushed to GitHub"
    else
        echo "Warning: git push failed, continuing deploy"
    fi
else
    echo "Warning: not a git repo, skipping auto-commit"
fi

# 先把服务器上的业务库(geo_cache.db 缓存 + appleid.db 账户)拉回本地覆盖,再推代码
# 这样本地始终保留服务器数据库的最新副本,且本地空库永远不会覆盖服务器
# 注意:远程 root 默认 shell 是 zsh,文件不存在的 glob 会报错,故 appleid.db 存在才拉
echo "rsync -avz -e \"ssh $SSH_OPTS\" $REMOTE_HOST:$REMOTE_DIR/data/geo_cache.db* data/"
rsync -avz -e "ssh $SSH_OPTS" "$REMOTE_HOST:$REMOTE_DIR/data/geo_cache.db*" data/
if ssh $SSH_OPTS $REMOTE_HOST "test -e $REMOTE_DIR/data/appleid.db"; then
    echo "rsync -avz -e \"ssh $SSH_OPTS\" $REMOTE_HOST:$REMOTE_DIR/data/appleid.db* data/"
    rsync -avz -e "ssh $SSH_OPTS" "$REMOTE_HOST:$REMOTE_DIR/data/appleid.db*" data/
else
    echo "(appleid.db 尚不存在,跳过拉取——首次部署时由服务启动创建)"
fi

echo "rsync -avz --delete -e \"ssh $SSH_OPTS\" --exclude 'venv' --exclude '__pycache__' --exclude '.DS_Store' --exclude '.git' --exclude 'deploy.sh' --exclude 'upload.sh' --exclude 'node_modules' --exclude 'GeoLite2-City.mmdb' --exclude 'GeoLite2-ASN.mmdb' --exclude '.gitignore' --exclude '.claude' --exclude 'command.txt' --exclude 'flask_secret.key' --exclude 'appleid_encryption.key' --exclude 'geo_cache.db' --exclude 'appleid.db' --exclude 'auth.db' --exclude 'Logs' --exclude 'limooo.cn.png' --exclude 'limooo.pem' --exclude '各种密钥.txt' \"$LOCAL_DIR\" $REMOTE_HOST:$REMOTE_DIR"
rsync -avz --delete -e "ssh $SSH_OPTS" \
    --exclude 'venv' \
    --exclude '__pycache__' \
    --exclude '.DS_Store' \
    --exclude '.git' \
    --exclude 'deploy.sh' \
    --exclude 'upload.sh' \
    --exclude 'node_modules' \
    --exclude 'GeoLite2-City.mmdb' \
    --exclude 'GeoLite2-ASN.mmdb' \
    --exclude '.gitignore' \
    --exclude '.claude' \
    --exclude 'command.txt' \
    --exclude 'flask_secret.key' \
    --exclude 'appleid_encryption.key' \
    --exclude 'geo_cache.db*' \
    --exclude 'appleid.db*' \
    --exclude 'auth.db*' \
    --exclude 'Logs' \
    --exclude 'limooo.cn.png' \
    --exclude 'limooo.pem' \
    --exclude '各种密钥.txt' \
    "$LOCAL_DIR" $REMOTE_HOST:$REMOTE_DIR

ssh $SSH_OPTS $REMOTE_HOST << 'EOF'
    set -e

    MISSING=""
    command -v rsync || MISSING="$MISSING rsync"
    command -v python3 || MISSING="$MISSING python3"
    command -v nginx || MISSING="$MISSING nginx"
    command -v ipset || MISSING="$MISSING ipset"
    if [ -n "$MISSING" ]; then
        echo "apt-get update"
        apt-get update
        echo "DEBIAN_FRONTEND=noninteractive apt-get install -y nginx rsync python3 python3-venv python3-pip ipset"
        DEBIAN_FRONTEND=noninteractive apt-get install -y nginx rsync python3 python3-venv python3-pip ipset
    fi
    # nginx 需带 http_v3 模块(HTTP/3/QUIC);Debian 官方源 1.25+ 自带,缺失则视为未装好
    if ! nginx -V 2>&1 | grep -q http_v3_module; then
        echo "FATAL: nginx 缺少 http_v3_module — 请检查系统/nginx 版本"
        exit 1
    fi
    # docker 仅服务 authentik(/opt/authentik 单独部署),缺失则自动安装
    if ! command -v docker; then
        echo "apt-get install -y docker.io"
        apt-get install -y docker.io
    fi

    echo "cd /var/www/limooo"
    cd /var/www/limooo

    echo "find . -name \"*.pyc\" -delete"
    find . -name "*.pyc" -delete
    echo "find . -name \"__pycache__\" -type d -exec rm -rf {} +"
    find . -name "__pycache__" -type d -exec rm -rf {} + || true

    if [ ! -d "venv" ]; then
        echo "python3 -m venv venv"
        python3 -m venv venv
    fi
    echo "./venv/bin/pip install --upgrade pip"
    ./venv/bin/pip install --upgrade pip
    echo "./venv/bin/pip install --upgrade -r ops/requirements.txt"
    ./venv/bin/pip install --upgrade -r ops/requirements.txt

    # 恢复 Cloudflare Origin CA 证书(nginx ssl_certificate 指向此处)
    if [ ! -f "/etc/nginx/ssl/origin-cert.pem" ] && [ -f "/var/www/limooo/secrets/origin-cert.pem" ]; then
        echo "mkdir -p /etc/nginx/ssl"
        mkdir -p /etc/nginx/ssl
        echo "chmod 700 /etc/nginx/ssl"
        chmod 700 /etc/nginx/ssl
        echo "cp /var/www/limooo/secrets/origin-cert.pem /etc/nginx/ssl/"
        cp /var/www/limooo/secrets/origin-cert.pem /etc/nginx/ssl/
        echo "cp /var/www/limooo/secrets/origin-key.pem /etc/nginx/ssl/"
        cp /var/www/limooo/secrets/origin-key.pem /etc/nginx/ssl/
        echo "chmod 600 /etc/nginx/ssl/origin-cert.pem /etc/nginx/ssl/origin-key.pem"
        chmod 600 /etc/nginx/ssl/origin-cert.pem /etc/nginx/ssl/origin-key.pem
    fi

    # 密钥迁移到 /etc/limooo/(chmod 600),避免与密文同目录存放
    # 已有密钥原样保留(不覆盖),否则 session 失效、Apple ID 密码解不开
    echo "sudo mkdir -p /etc/limooo"
    sudo mkdir -p /etc/limooo
    echo "sudo chmod 700 /etc/limooo"
    sudo chmod 700 /etc/limooo
    for kf in flask_secret.key appleid_encryption.key; do
        if [ ! -f "/etc/limooo/$kf" ]; then
            if [ -f "secrets/$kf" ]; then
                echo "sudo cp -p secrets/$kf /etc/limooo/$kf"
                sudo cp -p "secrets/$kf" "/etc/limooo/$kf"
            else
                echo "sudo touch /etc/limooo/$kf"
                sudo touch "/etc/limooo/$kf"   # 占位,由 Flask 首次启动生成
            fi
        fi
        echo "sudo chmod 600 /etc/limooo/$kf"
        sudo chmod 600 "/etc/limooo/$kf"
        # 迁移成功后清除项目目录残留密钥,避免与密文同目录
        if [ -f "secrets/$kf" ]; then
            echo "rm -f secrets/$kf"
            rm -f "secrets/$kf"
        fi
    done

    echo "sudo systemctl stop limooo || true"
    sudo systemctl stop limooo || true
    # 只杀 Flask 自己的 gunicorn(按启动路径匹配),避免误杀 authentik 的 gunicorn
    echo "sudo pkill -9 -f /var/www/limooo/venv/bin/gunicorn || true"
    sudo pkill -9 -f "/var/www/limooo/venv/bin/gunicorn" || true
    echo "sleep 1"
    sleep 1

    # 删除损坏的 geo_cache.db(0 字节文件会导致 500 错误)
    if [ -f "data/geo_cache.db" ] && [ ! -s "data/geo_cache.db" ]; then
        echo "rm -f data/geo_cache.db"
        rm -f data/geo_cache.db
    fi

    # Env file(secrets + API keys)— 正常由本地同步到 secrets/;缺失时兜底
    echo "mkdir -p secrets"
    mkdir -p secrets
    if [ ! -f "secrets/webauthn.env" ]; then
        echo "cat > secrets/webauthn.env << 'WEOF'"
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

    echo "sudo cp ops/limooo.service /etc/systemd/system/limooo.service"
    sudo cp ops/limooo.service /etc/systemd/system/limooo.service
    echo "sudo systemctl daemon-reload"
    sudo systemctl daemon-reload
    echo "sudo systemctl enable limooo"
    sudo systemctl enable limooo
    echo "sudo systemctl start limooo"
    sudo systemctl start limooo
    echo "sleep 2"
    sleep 2
    echo "sudo systemctl is-active limooo"
    sudo systemctl is-active limooo

    # nginx 主配置只 include /etc/nginx/conf.d/*.conf,必须放到 conf.d/ 才会生效
    # (sites-available/ + sites-enabled/ 的旧做法从未被加载,已废弃)
    echo "sudo cp ops/limooo.conf /etc/nginx/conf.d/limooo.conf"
    sudo cp ops/limooo.conf /etc/nginx/conf.d/limooo.conf
    echo "sudo rm -f /etc/nginx/sites-enabled/limooo.conf /etc/nginx/sites-available/limooo.conf"
    sudo rm -f /etc/nginx/sites-enabled/limooo.conf /etc/nginx/sites-available/limooo.conf
    echo "sudo cp ops/location-security.inc /etc/nginx/conf.d/location-security.inc"
    sudo cp ops/location-security.inc /etc/nginx/conf.d/location-security.inc

    # 删除默认站点,避免端口冲突
    if [ -f /etc/nginx/sites-enabled/default ]; then
        echo "sudo rm /etc/nginx/sites-enabled/default"
        sudo rm /etc/nginx/sites-enabled/default
    fi

    if sudo nginx -t; then
        echo "sudo systemctl restart nginx"
        sudo systemctl restart nginx
    else
        echo "FATAL: nginx 配置检查失败,中止部署"
        exit 1
    fi

    # 设置 auto_block 定时任务(每日 3:00)
    if ! crontab -l | grep -q 'auto_block.py'; then
        echo "(crontab -l; echo '0 3 * * * cd /var/www/limooo/src && ../venv/bin/python3 auto_block.py >> /var/log/auto_block.log 2>&1') | crontab -"
        (crontab -l; echo "0 3 * * * cd /var/www/limooo/src && ../venv/bin/python3 auto_block.py >> /var/log/auto_block.log 2>&1") | crontab -
    fi

    echo "cd /var/www/limooo/src && ../venv/bin/python3 auto_block.py ipset"
    cd /var/www/limooo/src && ../venv/bin/python3 auto_block.py ipset
EOF

echo "bash ops/pages_deploy.sh --verbose"
bash ops/pages_deploy.sh --verbose
