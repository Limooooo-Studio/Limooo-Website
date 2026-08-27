#!/usr/bin/env bash

# Limooo D1 迁移入口。
#
# 用法：
#   bash ops/migrate_d1.sh --dry-run          # 只打印待执行项，不连接 D1
#   bash ops/migrate_d1.sh                    # 按顺序执行 ops/migrations/*.sql
#   bash ops/migrate_d1.sh --check-schema --remote  # 只读校验表是否齐全
#
# 默认生产执行使用 --remote；没有该参数时仍按真实模式执行，以便在本地
# wrangler 配置下调试。迁移前请先备份 D1（见 docs/parallel-actions.md）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/ops/migrations"
STATE_FILE="${D1_STATE_FILE:-$ROOT/.d1-migrations/applied}"
LEGACY_STATE_FILE="/tmp/limooo-d1-schema-state"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-limooo}"
WRANGLER_BIN="${WRANGLER_BIN:-}"
if [ -n "$WRANGLER_BIN" ]; then
    WRANGLER_CMD=("$WRANGLER_BIN")
else
    WRANGLER_CMD=(npx --no-install wrangler)
fi

DRY_RUN=0
REMOTE=0
CHECK_SCHEMA=0

usage() {
    cat <<'EOF'
用法：bash ops/migrate_d1.sh [--dry-run] [--remote] [--check-schema]

  --dry-run      只打印迁移状态，不连接 D1、不写任何数据。
  --remote       对远程 D1 执行/校验（默认用于生产）。
  --check-schema 只检查当前 D1 是否包含预期表，不执行迁移。
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --remote) REMOTE=1 ;;
        --check-schema) CHECK_SCHEMA=1 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "FATAL: 未知参数 $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [ ! -d "$MIGRATIONS_DIR" ]; then
    echo "FATAL: 迁移目录不存在 $MIGRATIONS_DIR" >&2
    exit 1
fi

# 兼容旧版临时状态文件：迁移到仓库内持久化位置，避免重启/换机器丢失。
if [ -f "$LEGACY_STATE_FILE" ] && [ ! -f "$STATE_FILE" ]; then
    mkdir -p "$(dirname "$STATE_FILE")"
    cp "$LEGACY_STATE_FILE" "$STATE_FILE"
    echo "[d1] migrated legacy state to $STATE_FILE"
fi

MIGRATIONS=()
while IFS= read -r file; do
    MIGRATIONS+=("$file")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)

for file in "${MIGRATIONS[@]}"; do
    name="$(basename "$file")"
    if ! [[ "$name" =~ ^[0-9]{3}_[A-Za-z0-9_-]+\.sql$ ]]; then
        echo "FATAL: 迁移文件名不符合 001_name.sql 约定: $name" >&2
        exit 1
    fi
done

apply_state() {
    local name="$1"
    mkdir -p "$(dirname "$STATE_FILE")"
    printf '%s\n' "$name" >> "$STATE_FILE"
}

is_applied() {
    local name="$1"
    [ -f "$STATE_FILE" ] && grep -Fxq "$name" "$STATE_FILE"
}

if [ "$CHECK_SCHEMA" = 1 ]; then
    expected=(apple_accounts blocked_ips visitors ray_log events visitors_v2 ray_log_v2 visitors_daily retention_state schema_version blocklist_audit)
    if [ -f "$MIGRATIONS_DIR/008_auth_sessions.sql" ] || [ -f "$MIGRATIONS_DIR/004_auth_sessions.sql" ]; then
        expected+=(auth_sessions)
    fi
    echo "[d1] schema check: expected ${expected[*]}"
    if [ "$DRY_RUN" = 1 ]; then
        echo "[d1] dry-run：未连接 D1；实际模式将读取 sqlite_master 并校验以上表。"
        exit 0
    fi
    D1_ARGS=(--remote)
    [ "$REMOTE" = 0 ] && D1_ARGS=()
    output="$("${WRANGLER_CMD[@]}" d1 execute "${D1_DATABASE_NAME}" \
        --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" \
        --json "${D1_ARGS[@]}")"
    missing=()
    for table in "${expected[@]}"; do
        if ! printf '%s' "$output" | grep -q "$table"; then
            missing+=("$table")
        fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "FATAL: D1 缺少预期表: ${missing[*]}" >&2
        exit 1
    fi
    echo "[d1] schema check: OK"
    exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
    echo "[d1] dry-run：以下迁移将按顺序执行（未连接 D1）"
    for file in "${MIGRATIONS[@]}"; do
        name="$(basename "$file")"
        if is_applied "$name"; then
            echo "  [applied] $name"
        else
            echo "  [pending] $name"
        fi
    done
    echo "[d1] state file: $STATE_FILE"
    exit 0
fi

echo "[d1] 按序执行 ${#MIGRATIONS[@]} 个迁移（${D1_DATABASE_NAME}）"
D1_ARGS=(--remote)
[ "$REMOTE" = 0 ] && D1_ARGS=()

"${WRANGLER_CMD[@]}" d1 execute "${D1_DATABASE_NAME}" \
    --command "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));" \
    "${D1_ARGS[@]}"

for file in "${MIGRATIONS[@]}"; do
    name="$(basename "$file")"
    if is_applied "$name"; then
        echo "[d1] skip (recorded): $name"
        continue
    fi
    echo "[d1] apply: $name"
    "${WRANGLER_CMD[@]}" d1 execute "${D1_DATABASE_NAME}" --file "$file" "${D1_ARGS[@]}"
    version="${name%%_*}"
    "${WRANGLER_CMD[@]}" d1 execute "${D1_DATABASE_NAME}" \
        --command "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES ($version, datetime('now'));" \
        "${D1_ARGS[@]}"
    apply_state "$name"
done

echo "[d1] done"
