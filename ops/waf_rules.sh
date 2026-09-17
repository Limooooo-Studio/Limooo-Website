#!/usr/bin/env bash

# Limooo WAF 自定义规则压缩 / 快照。
#
# 背景（docs/17 §10）：免费版「自定义规则」只有 5 条名额，而 IP Access Rules
# 有 50,000 条且不占名额。本脚本把「单 IP 放行」这类一句话规则从自定义规则
# 迁移到 IP Access Rules，并可选清理已禁用的规则。
#
# 用法：
#   bash ops/waf_rules.sh --show                 # 只打印当前规则，不写任何东西
#   bash ops/waf_rules.sh --snapshot             # 抓取快照到 ops/waf/rules.snapshot.json
#   bash ops/waf_rules.sh --dry-run              # 打印计划（默认行为）
#   bash ops/waf_rules.sh --apply                # 执行：skip(单IP) → IP Access Rule
#   bash ops/waf_rules.sh --apply --drop-disabled  # 额外删除 disabled 的规则
#
# 凭据始终留在服务器 secrets/webauthn.env，本脚本通过 ssh 调用 API，
# 从不读取或回显 token 值。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_HOST="${WAF_SSH_HOST:-limooo}"
ENV_FILE="${WAF_ENV_FILE:-/var/www/limooo/secrets/webauthn.env}"
ZONE_NAME="${WAF_ZONE_NAME:-limooo.cn}"
SNAP_DIR="$ROOT/ops/waf"
SNAP="$SNAP_DIR/rules.snapshot.json"
PHASE_PATH="/rulesets/phases/http_request_firewall_custom/entrypoint"

MODE=plan
DROP_DISABLED=0

usage() {
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --show) MODE=show ;;
        --snapshot) MODE=snapshot ;;
        --dry-run) MODE=plan ;;
        --apply) MODE=apply ;;
        --drop-disabled) DROP_DISABLED=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

# ── 远端 API 调用（token 不离开服务器） ──────────────
api() {
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        printf '%s' "$body" | ssh "$SSH_HOST" \
            "set -a; . '$ENV_FILE'; set +a; curl -s -X $method \
             -H \"Authorization: Bearer \$CLOUDFLARE_API_TOKEN\" \
             -H 'Content-Type: application/json' --data-binary @- \
             'https://api.cloudflare.com/client/v4$path'"
    else
        ssh -n "$SSH_HOST" \
            "set -a; . '$ENV_FILE'; set +a; curl -s -X $method \
             -H \"Authorization: Bearer \$CLOUDFLARE_API_TOKEN\" \
             'https://api.cloudflare.com/client/v4$path'"
    fi
}

jsonq() { python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }

ZID="$(api GET "/zones?name=$ZONE_NAME" | jsonq 'print((d.get("result") or [{}])[0].get("id",""))')"
[ -n "$ZID" ] || { echo "无法解析 zone id（检查 ssh / secrets）" >&2; exit 1; }

fetch_entrypoint() { api GET "/zones/$ZID$PHASE_PATH"; }

print_rules() {
    python3 - "$SNAPFILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
res = d.get("result") or {}
print(f"ruleset v{res.get('version')} / {res.get('last_updated')}")
for r in res.get("rules", []):
    e = r.get("expression", "")
    if len(e) > 48:
        e = e[:45] + "..."
    print(f"  {r.get('action'):13} enabled={str(r.get('enabled')):6} {e}")
print(f"  合计 {len(res.get('rules', []))}/5 条自定义规则名额")
PY
}

SNAPFILE="$(mktemp)"
trap 'rm -f "$SNAPFILE"' EXIT
fetch_entrypoint > "$SNAPFILE"

if [ "$MODE" = show ]; then
    print_rules
    exit 0
fi

mkdir -p "$SNAP_DIR"
{
    python3 - "$SNAPFILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
out = {
    "captured_at": __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    ).isoformat(),
    "zone": "limooo.cn",
    "phase": "http_request_firewall_custom",
    "ruleset": d.get("result") or {},
}
json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
PY
} > "$SNAP"

if [ "$MODE" = snapshot ]; then
    echo "已写入 $SNAP"
    print_rules
    exit 0
fi

echo "=== 当前 ==="
print_rules
echo

python3 - "$SNAPFILE" "$DROP_DISABLED" > /tmp/_waf_plan.txt <<'PY'
import json, sys, re
d = json.load(open(sys.argv[1]))
drop_disabled = sys.argv[2] == "1"
rules = (d.get("result") or {}).get("rules", [])
ips, deletable = [], []
for r in rules:
    m = re.fullmatch(r"ip\.src eq ([0-9a-fA-F\.:]+)", (r.get("expression") or "").strip())
    if r.get("action") == "skip" and m:
        ips.append(m.group(1))
        deletable.append((r.get("id"), r.get("action"), "skip(单IP) → IP Access Rule whitelist"))
    elif drop_disabled and r.get("enabled") is False:
        deletable.append((r.get("id"), r.get("action"), "删除（已禁用）"))
print("IPS=" + " ".join(ips))
json.dump(deletable, sys.stdout)
PY
PLAN_IPS="$(grep '^IPS=' /tmp/_waf_plan.txt | cut -d= -f2-)"
PLAN_DEL="$(grep -v '^IPS=' /tmp/_waf_plan.txt)"
rm -f /tmp/_waf_plan.txt

echo "=== 计划 ==="
python3 -c "
import json,sys
p=json.loads('''$PLAN_DEL''')
for i,a,why in p: print(f'  - {a:13} {why}')
print(f'  新增 IP Access Rule: {len(\"$PLAN_IPS\".split())} 条')
"
echo

if [ "$MODE" != apply ]; then
    echo "（dry-run：未做任何改动。加 --apply 执行）"
    exit 0
fi

echo "=== 执行 ==="
for ip in $PLAN_IPS; do
    resp="$(api POST "/zones/$ZID/firewall/access_rules/rules" \
        "{\"mode\":\"whitelist\",\"configuration\":{\"target\":\"ip\",\"value\":\"$ip\"},\"notes\":\"limooo: bypass security for trusted IP (migrated from custom skip rule)\"}")"
    echo "$resp" | jsonq 'print("  access rule:", "OK" if d.get("success") else "FAIL "+json.dumps(d.get("errors"))[:160])'
done

python3 -c "
import json
p=json.loads('''$PLAN_DEL''')
print('\n'.join(i for i,_,_ in p))
" | while read -r rid; do
    [ -n "$rid" ] || continue
    api DELETE "/zones/$ZID/rulesets/$(fetch_entrypoint | jsonq 'print((d.get("result") or {}).get("id",""))')/rules/$rid" \
        | jsonq 'print("  deleted rule:", "OK" if d.get("success") else "FAIL "+json.dumps(d.get("errors"))[:160])'
done

echo
echo "=== 结果 ==="
fetch_entrypoint > "$SNAPFILE"
print_rules
echo "快照: $SNAP"
