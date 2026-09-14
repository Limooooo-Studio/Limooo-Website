#!/usr/bin/env bash

# Limooo - 安装健康检查 cron（docs/06）
#
# 每 5 分钟执行一次 check_health.py；脚本自身在判定 down 后会每 10 秒复查，
# 直到恢复或超出窗口，因此 Kuma Push 心跳最迟 10 秒内回到 up。
# 本脚本只替换 check_health.py 那一行，其余 crontab 条目原样保留。
# 用法：REMOTE_HOST=limooo bash ops/install_health_cron.sh

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/limooo}"
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=10)
CRON_LINE="*/5 * * * * cd ${REMOTE_DIR}/ops && ../venv/bin/python3 check_health.py >> /var/log/limooo-health.log 2>&1"

ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    current=\$(crontab -l 2>/dev/null || true)
    if printf '%s\n' \"\$current\" | grep -qF '$CRON_LINE'; then
        echo '健康检查 cron 已是当前版本，跳过'
        exit 0
    fi
    # 只删掉旧的 check_health.py 行，其余条目（auto_block / acme / prune）原样保留
    {
        printf '%s\n' \"\$current\" | grep -v 'check_health.py' | grep -v '^[[:space:]]*$' || true
        echo '$CRON_LINE'
    } | crontab -
    echo '健康检查 cron 已安装：*/5 分钟 + down 后 10 秒复查'
    crontab -l | grep 'check_health.py'
"
