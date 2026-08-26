#!/usr/bin/env bash

# Limooo - 安装每小时健康检查 cron（docs/06）
#
# 本脚本不会覆盖已有 crontab，只在缺少 check_health.py 条目时追加；
# 保留现有 03:00 auto_block.py。执行前请先在 docs/parallel-actions.md 预约。
# 用法：REMOTE_HOST=limooo bash ops/install_health_cron.sh

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/limooo}"
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=10)
CRON_LINE="17 * * * * cd ${REMOTE_DIR}/ops && ../venv/bin/python3 check_health.py >> /var/log/limooo-health.log 2>&1"

ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    if ! crontab -l 2>/dev/null | grep -q 'check_health.py'; then
        (crontab -l 2>/dev/null; echo '$CRON_LINE') | crontab -
        echo '健康检查 cron 已安装'
    else
        echo '健康检查 cron 已存在，跳过'
    fi
"
