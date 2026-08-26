#!/usr/bin/env python3

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

"""
Auto-block script: scan Nginx access.log for IPs that never returned 200 or hit
known scan paths, append their /24 to blocklist.txt, then sync to ipset and
Cloudflare IP List.

Usage:
    python3 auto_block.py            # full: scan + write blocklist + sync ipset + CF
    python3 auto_block.py ipset      # sync blocklist.txt to ipset/iptables only
    python3 auto_block.py cf         # sync blocklist.txt to Cloudflare only
    python3 auto_block.py sync       # sync to ipset + Cloudflare
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict

# 仓库根目录（本文件位于 src/ 下，向上取一层）
from config import (
    BLOCKLIST_FILE as BLOCKLIST_TXT,
    CLOUDFLARE_API_BASE as API,
    CF_BATCH_SIZE as BATCH,
    CF_LIST_NAME as LIST_NAME,
    D1_DATABASE_ID,
    ENV_FILE,
)
LOG_PATTERN = re.compile(r'^(\S+).*?"([^"]*)"\s+(\d+)')

# 已知恶意扫描路径模式：命中任一条即零容忍封禁
SCAN_PATTERNS = [
    re.compile(r"/\.env"),
    re.compile(r"/\.git/"),
    re.compile(r"/wp-admin"),
    re.compile(r"/wp-login"),
    re.compile(r"/actuator/"),
    re.compile(r"/_profiler"),
    re.compile(r"/\.aws/"),
    re.compile(r"/\.DS_Store"),
    re.compile(r"/config\.env"),
    re.compile(r"/\.{2,}/"),
    re.compile(r"/xmlrpc\.php"),
    re.compile(r"/\.(svn|cvs|hg)/"),
    re.compile(r"/(admin|manager|test)\.php$"),
    re.compile(r"/phpmyadmin"),
    re.compile(r"/\.npmrc"),
    re.compile(r"/composer\.json"),
]


def _is_scan_path(path: str) -> bool:
    """判断请求路径是否命中已知恶意扫描特征"""
    for pat in SCAN_PATTERNS:
        if pat.search(path):
            return True
    return False


# Match x.x.x.0/24
CIDR24_RE = re.compile(r'^(\d+\.\d+\.\d+)\.0/24$')


def collect_logs() -> list[str]:
    files = []
    for f in ["/var/log/nginx/access.log", "/var/log/nginx/access.log.1"]:
        if os.path.isfile(f):
            files.append(f)
    if not files:
        print("[!] Nginx access.log not found")
    return files


def analyze(files: list[str]) -> dict:
    ips = defaultdict(lambda: {"total": 0, "ok": 0, "scan": False})
    for fp in files:
        try:
            with open(fp, errors="ignore") as f:
                for line in f:
                    m = LOG_PATTERN.match(line)
                    if not m:
                        continue
                    ip = m.group(1)
                    if ip in ("127.0.0.1", "-") or ip.startswith("192.168."):
                        continue
                    d = ips[ip]
                    d["total"] += 1
                    if m.group(3) == "200":
                        d["ok"] += 1
                    parts = m.group(2).split()
                    if len(parts) < 2:
                        continue
                    path = parts[1]
                    if not d["scan"] and _is_scan_path(path):
                        d["scan"] = True
        except FileNotFoundError:
            pass
    return ips


def read_blocklist_txt(path: str) -> tuple[list[str], set[str]]:
    """
    Read blocklist.txt, return:
    - static lines (comments + non-/24 manual entries)
    - existing /24 prefix set (stripped of .0/24 suffix)
    """
    static_lines: list[str] = []
    existing_prefixes: set[str] = set()

    try:
        with open(path) as f:
            for line in f:
                stripped = line.rstrip("\n")
                if stripped.startswith("#") or not stripped.strip():
                    static_lines.append(stripped)
                    continue
                m = CIDR24_RE.match(stripped)
                if m:
                    existing_prefixes.add(m.group(1))
                else:
                    static_lines.append(stripped)
    except FileNotFoundError:
        pass

    return static_lines, existing_prefixes


# ── ipset / iptables 同步（原 sync_blocklist.py） ──────
def sync_ipset() -> None:
    """把 blocklist.txt 同步到内核 ipset(ban24) + iptables DROP 规则"""
    entries = []
    try:
        with open(BLOCKLIST_TXT) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    entries.append(line)
    except FileNotFoundError:
        print("[!] blocklist.txt not found")
        return

    subprocess.run(["ipset", "create", "ban24", "hash:net"], capture_output=True)

    count = 0
    for entry in entries:
        r = subprocess.run(["ipset", "add", "ban24", entry], capture_output=True)
        if r.returncode == 0:
            count += 1

    print(f"Added {count} new (skipped existing), total {len(entries)} entries")

    r = subprocess.run(
        ["iptables", "-C", "INPUT", "-m", "set", "--match-set", "ban24", "src", "-j", "DROP"],
        capture_output=True,
    )
    if r.returncode != 0:
        subprocess.run(
            ["iptables", "-I", "INPUT", "-m", "set", "--match-set", "ban24", "src", "-j", "DROP"],
        )
        print("iptables rule added")


# ── Cloudflare IP List 同步（原 sync_blocklist_cf.py） ──
# 读 webauthn.env 里的 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，
# 不存在则跳过。使用纯标准库(urllib)。
def load_env(path: str) -> dict:
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env


def read_blocklist(path: str) -> list[str]:
    entries = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    entries.append(line)
    except FileNotFoundError:
        print("[!] blocklist.txt not found", file=sys.stderr)
    return entries


def _call(token: str, method: str, url: str, body=None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _wait_operation(token: str, account_id: str, operation_id: str | None):
    if not operation_id:
        return
    for _ in range(40):
        resp = _call(token, "GET",
                     f"{API}/accounts/{account_id}/rules/lists/bulk_operations/{operation_id}")
        status = resp.get("result", {}).get("status")
        if status in ("completed", "failed"):
            return
        time.sleep(2)


def _add_items(token: str, account_id: str, list_id: str, ips: list[str]):
    for i in range(0, len(ips), BATCH):
        chunk = [{"ip": ip} for ip in ips[i:i + BATCH]]
        resp = _call(token, "POST", f"{API}/accounts/{account_id}/rules/lists/{list_id}/items", chunk)
        _wait_operation(token, account_id, resp.get("result", {}).get("operation_id"))


def _remove_items(token: str, account_id: str, list_id: str, item_ids: list[str]):
    for i in range(0, len(item_ids), BATCH):
        # Cloudflare DELETE 只接受 {"items": [{"id": ...}]}，裸数组会返回 400 filters.api.invalid_json
        chunk = [{"id": x} for x in item_ids[i:i + BATCH]]
        resp = _call(token, "DELETE", f"{API}/accounts/{account_id}/rules/lists/{list_id}/items", {"items": chunk})
        _wait_operation(token, account_id, resp.get("result", {}).get("operation_id"))


def sync_cloudflare() -> int:
    """把 blocklist.txt 增量同步到 Cloudflare IP List，返回退出码"""
    env = load_env(ENV_FILE)
    token = env.get("CLOUDFLARE_API_TOKEN", "")
    account_id = env.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not account_id:
        print("[cf] CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing, skipping", file=sys.stderr)
        return 0

    entries = read_blocklist(BLOCKLIST_TXT)
    if not entries:
        print("[!] blocklist empty, skipping CF sync", file=sys.stderr)
        return 0

    try:
        # Find existing list
        resp = _call(token, "GET", f"{API}/accounts/{account_id}/rules/lists?per_page=100")
        lst = next((l for l in resp.get("result", []) if l["name"] == LIST_NAME), None)

        if lst is None:
            resp = _call(token, "POST", f"{API}/accounts/{account_id}/rules/lists",
                         {"name": LIST_NAME, "kind": "ip", "description": "auto-blocked networks from nginx logs"})
            lst = resp["result"]
            _add_items(token, account_id, lst["id"], entries)
            print(f"[cf] created list {LIST_NAME} with {len(entries)} items", flush=True)
            return 0

        # Current items in CF (ip -> item id for deletion), follow cursor pagination
        cur = {}
        base = f"{API}/accounts/{account_id}/rules/lists/{lst['id']}/items"
        url = base
        while url:
            resp = _call(token, "GET", url)
            for it in resp.get("result", []):
                cur[it["ip"]] = it["id"]
            cursors = (resp.get("result_info") or {}).get("cursors") or {}
            after = cursors.get("after")
            url = f"{base}?cursor={after}" if after else None

        target = set(entries)
        current = set(cur)
        to_add = sorted(target - current)
        to_remove = sorted(current - target)

        if not to_add and not to_remove:
            print(f"[cf] no change ({len(current)} items)", flush=True)
            return 0

        if to_add:
            _add_items(token, account_id, lst["id"], to_add)
        if to_remove:
            _remove_items(token, account_id, lst["id"], [cur[ip] for ip in to_remove])

        print(f"[cf] synced: +{len(to_add)} -{len(to_remove)} (total {len(target)})", flush=True)
    except urllib.error.HTTPError as e:
        print(f"[cf] HTTP error {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"[cf] error: {e}", file=sys.stderr)
        return 1

    return 0


def _normalize_cidr(line: str) -> str | None:
    """blocklist.txt 行 → CIDR（裸 a.b.c 补 .0/24，其余保持原样）"""
    line = line.strip()
    if re.fullmatch(r"\d{1,3}\.\d{1,3}\.\d{1,3}", line):
        return f"{line}.0/24"
    if re.fullmatch(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(/\d{1,2})?", line):
        return line
    return None


def sync_d1() -> int:
    """把 blocklist.txt 全量 upsert 到 D1 blocked_ips（CF IP List 由 sync-worker 每天同步）"""
    env = load_env(ENV_FILE)
    token = env.get("CLOUDFLARE_API_TOKEN", "")
    account_id = env.get("CLOUDFLARE_ACCOUNT_ID", "")
    db_id = env.get("D1_DATABASE_ID", D1_DATABASE_ID)
    if not token or not account_id or not db_id:
        print("[d1] CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID missing, skipping", file=sys.stderr)
        return 0

    cidrs = []
    for line in read_blocklist(BLOCKLIST_TXT):
        c = _normalize_cidr(line)
        if c and c not in cidrs:
            cidrs.append(c)
    if not cidrs:
        print("[d1] blocklist empty, skipping", file=sys.stderr)
        return 0

    values = ",".join(f"('{c}', 'auto_block')" for c in cidrs)
    sql = f"INSERT OR IGNORE INTO blocked_ips (cidr, note) VALUES {values};"
    try:
        resp = _call(token, "POST",
                     f"{API}/accounts/{account_id}/d1/database/{db_id}/query",
                     {"sql": sql})
        meta = resp.get("result", [{}])[0].get("meta", {})
        print(f"[d1] synced {len(cidrs)} entries to D1 (changes={meta.get('changes', 0)})", flush=True)
    except urllib.error.HTTPError as e:
        print(f"[d1] HTTP error {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"[d1] error: {e}", file=sys.stderr)
        return 1
    return 0


# ── 完整扫描流程（原 auto_block.py main） ──────────────
def run_scan() -> None:
    files = collect_logs()
    if not files:
        return

    print(f"[auto_block] Analyzing logs...", flush=True)
    ips = analyze(files)
    print(f"  {len(ips)} unique IPs", flush=True)

    bad = {ip for ip, d in ips.items() if d["ok"] == 0 or d["scan"]}
    prefixes = set()
    for ip in bad:
        parts = ip.split(".")
        if len(parts) >= 3:
            prefixes.add(f"{parts[0]}.{parts[1]}.{parts[2]}")

    static_lines, existing_prefixes = read_blocklist_txt(BLOCKLIST_TXT)

    new_ones = sorted(prefixes - existing_prefixes)
    if not new_ones:
        print(f"  No new prefixes, {len(existing_prefixes)} existing /24", flush=True)
        return

    all_prefixes = sorted(existing_prefixes | prefixes)

    # Rewrite blocklist.txt
    with open(BLOCKLIST_TXT, "w") as f:
        for line in static_lines:
            f.write(line + "\n")
        if static_lines:
            f.write("\n")
        for p in all_prefixes:
            f.write(f"{p}.0/24\n")

    print(f"  blocklist.txt updated", flush=True)

    sync_ipset()
    print(f"  Added {len(new_ones)} new /24 (total {len(all_prefixes)}), synced to ipset", flush=True)

    sync_d1()
    # TODO: sync-worker 部署上线后，删掉下面这行（CF IP List 改由 sync-worker 每天从 D1 同步）
    sync_cloudflare()
    print("  Synced new blocks to D1 + Cloudflare IP List", flush=True)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "ipset":
        sync_ipset()
    elif cmd == "cf":
        sys.exit(sync_cloudflare())
    elif cmd == "sync":
        sync_ipset()
        sys.exit(sync_cloudflare())
    else:
        run_scan()


if __name__ == "__main__":
    main()
