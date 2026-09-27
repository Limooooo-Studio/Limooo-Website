#!/usr/bin/env bash

# Limooo WAF custom rule compaction / snapshot.
#
# Background (docs/17 section 10): the free plan allows only 5 custom rules,
# while IP Access Rules allow 50,000 and do not consume that quota. This script
# migrates one-line rules such as single-IP allow entries from custom rules to
# IP Access Rules, and can optionally clean up disabled rules.
#
# Usage:
#   bash ops/waf_rules.sh --show                 # print current rules only, write nothing
#   bash ops/waf_rules.sh --snapshot             # write snapshot to ops/waf/rules.snapshot.json
#   bash ops/waf_rules.sh --dry-run              # print the plan (default behaviour)
#   bash ops/waf_rules.sh --apply                # execute: skip(single IP) -> IP Access Rule
#   bash ops/waf_rules.sh --apply --drop-disabled  # also delete disabled rules
#
# Credentials stay on the server in secrets/webauthn.env; this script calls the
# API over ssh and never reads or echoes token values.

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
    # 打印文件头注释块（第 3 行起，到第一个非注释行为止），不再写死行号。
    awk 'NR>=3 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --show) MODE=show ;;
        --snapshot) MODE=snapshot ;;
        --dry-run) MODE=plan ;;
        --apply) MODE=apply ;;
        --drop-disabled) DROP_DISABLED=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
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
[ -n "$ZID" ] || { echo "cannot resolve zone id (check ssh / secrets)" >&2; exit 1; }

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
    echo "wrote $SNAP"
    print_rules
    exit 0
fi

echo "current"
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

echo "plan"
python3 -c "
import json,sys
p=json.loads('''$PLAN_DEL''')
for i,a,why in p: print(f'  - {a:13} {why}')
print(f'  新增 IP Access Rule: {len(\"$PLAN_IPS\".split())} 条')
"
echo

if [ "$MODE" != apply ]; then
    echo "(dry-run: nothing changed. pass --apply to execute)"
    exit 0
fi

echo "execute"
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
echo "result"
fetch_entrypoint > "$SNAPFILE"
print_rules
echo "snapshot: $SNAP"
