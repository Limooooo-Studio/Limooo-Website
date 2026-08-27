#!/usr/bin/env bash

# Limooo - 安装 D1 保留策略 cron（docs/11）
#
# 本脚本不会覆盖已有 crontab，只在缺少对应条目时追加。
# 聚合与清理错峰执行：聚合每小时一次、清理每天一次。
# 生产执行前请先备份 D1 并在 docs/parallel-actions.md 预约。
#
# 用法：REMOTE_HOST=limooo bash ops/install_retention_cron.sh

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-limooo}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/limooo}"
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=10)

AGGREGATE_LINE="23 * * * * cd ${REMOTE_DIR}/ops && ../venv/bin/python3 prune_d1.py --mode aggregate --apply >> /var/log/limooo-retention.log 2>&1"
PRUNE_LINE="47 3 * * * cd ${REMOTE_DIR}/ops && ../venv/bin/python3 prune_d1.py --mode prune --apply >> /var/log/limooo-retention.log 2>&1"

ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "
    ADDED=''
    if ! crontab -l 2>/dev/null | grep -q 'prune_d1.py --mode aggregate'; then
        (crontab -l 2>/dev/null; echo '$AGGREGATE_LINE') | crontab -
        ADDED=\"\$ADDED aggregate\"
    fi
    if ! crontab -l 2>/dev/null | grep -q 'prune_d1.py --mode prune'; then
        (crontab -l 2>/dev/null; echo '$PRUNE_LINE') | crontab -
        ADDED=\"\$ADDED prune\"
    fi
    if [ -n \"\$ADDED\" ]; then
        echo \"retention cron installed:\$ADDED\"
    else
        echo 'retention cron 已存在，跳过'
    fi
"
