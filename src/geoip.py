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
GeoIP 维护脚本：访客地理位置预缓存 + GeoLite2 数据库更新

用法：
    python3 geoip.py cache    # 每日 IP 地理位置预缓存
    python3 geoip.py update   # 更新 GeoLite2-City/ASN 数据库

Crontab：
    0 2 * * * cd /var/www/limooo && python3 geoip.py cache >> /var/log/geo_cache.log 2>&1
    0 3 * * 3 cd /var/www/limooo && python3 geoip.py update >> /var/log/geoip_update.log 2>&1
"""

import hashlib
import os
import shutil
import sqlite3
import ssl
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

import geoip2.database
import geoip2.errors

from common import (
    BASE_DIR,
    DATA_DIR,
    NGINX_LOG,
    LOG_PATTERN,
    is_private_ip,
    ensure_geo_cache,
    get_cached_geo,
    cache_geo,
)

GEOIP_CITY_DB = os.path.join(DATA_DIR, "GeoLite2-City.mmdb")
GEOIP_ASN_DB = os.path.join(DATA_DIR, "GeoLite2-ASN.mmdb")
DATABASE = os.path.join(DATA_DIR, "geo_cache.db")

# ── GeoLite2 数据库下载配置 ────────────────────────────
# mirrors: 按优先级排列的镜像源列表
# min_size_mb: 文件大小下限，低于此值视为下载异常，自动丢弃
DATABASES = {
    "GeoLite2-City.mmdb": {
        "mirrors": [
            "https://gh-proxy.com/https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-City.mmdb",
            "https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-City.mmdb",
        ],
        "min_size_mb": 10,
    },
    "GeoLite2-ASN.mmdb": {
        "mirrors": [
            "https://gh-proxy.com/https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-ASN.mmdb",
            "https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-ASN.mmdb",
        ],
        "min_size_mb": 1,
    },
}


def md5_hex(path: Path) -> str:
    """计算文件的 MD5 哈希值，用于判断文件是否有变化"""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


# ── 下载方法（降级尝试：urllib → curl） ──────────────
def download_urllib(url: str, dest: Path) -> bool:
    """使用 urllib 下载（Python 内置，不需要额外依赖）"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ctx, timeout=300) as resp, open(dest, "wb") as f:
            shutil.copyfileobj(resp, f, length=1024 * 1024)
        return True
    except Exception as e:
        print(f"    urllib 失败: {e}")
        return False


def download_curl(url: str, dest: Path) -> bool:
    """使用 curl 下载（系统自带，处理 HTTPS 更稳定）"""
    try:
        subprocess.run(
            ["curl", "-k", "-L", "-o", str(dest), url],
            check=True,
            timeout=300,
            capture_output=True,
        )
        return True
    except Exception as e:
        print(f"    curl 失败: {e}")
        return False


def try_download(url: str, dest: Path) -> bool:
    """尝试用所有可用方法下载，任意一种成功即返回 True"""
    print(f"  ⏳ {url}")
    for method in (download_urllib, download_curl):
        if method(url, dest):
            return True
    return False


def update_one(name: str, cfg: dict) -> bool:
    """更新单个 mmdb 数据库文件，返回 True 表示有变更"""
    db_file = os.path.join(DATA_DIR, name)
    db_tmp = os.path.join(DATA_DIR, f"{name}.tmp")

    old_md5 = md5_hex(db_file) if db_file.exists() else None
    print(f"\n  [{name}] 当前 MD5: {old_md5 or '(无)'}")

    # 依次尝试各镜像源
    ok = False
    for url in cfg["mirrors"]:
        if try_download(url, db_tmp):
            ok = True
            break

    if not ok:
        print(f"  [error] [{name}] 所有镜像下载失败", file=sys.stderr)
        return False

    # 文件完整性检查：大小不能低于阈值（防止下载到错误页面）
    size_mb = db_tmp.stat().st_size / (1024 * 1024)
    if size_mb < cfg["min_size_mb"]:
        print(f"  [error] [{name}] 文件异常 ({size_mb:.1f} MB)，已丢弃", file=sys.stderr)
        db_tmp.unlink(missing_ok=True)
        return False

    new_md5 = md5_hex(db_tmp)
    print(f"  新 MD5: {new_md5}  ({size_mb:.1f} MB)")

    # MD5 未变则跳过
    if old_md5 and old_md5 == new_md5:
        print(f"  [{name}] 已是最新，跳过")
        db_tmp.unlink()
        return False

    # 原子替换旧文件
    shutil.move(str(db_tmp), str(db_file))
    print(f"  [ok] [{name}] 更新完成")
    return True


def collect_unique_ips(max_lines: int = 20000) -> dict:
    """从 Nginx 日志中收集所有不重复的访客 IP（跳过私有地址和静态资源）"""
    visitors: dict[str, dict] = {}
    try:
        with open(NGINX_LOG, "r", errors="ignore") as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(f"[error] 日志文件不存在: {NGINX_LOG}")
        return visitors

    # 倒序遍历日志，最新的 IP 优先
    for line in reversed(lines[-max_lines:]):
        m = LOG_PATTERN.match(line.strip())
        if not m:
            continue
        ip = m.group(1)
        if is_private_ip(ip):
            continue
        # 跳过静态资源和 API 请求（这些不是真实访客）
        parts = m.group(3).split()
        path = parts[1] if len(parts) > 1 else ""
        if path.startswith(("/static", "/api/")):
            continue
        if ip not in visitors:
            visitors[ip] = {"count": 0}
        visitors[ip]["count"] += 1
    return visitors


def cmd_cache() -> None:
    """每日 IP 地理位置预缓存（原 cache_daily.py）"""
    os.chdir(BASE_DIR)
    print(
        f"=== 每日 IP 缓存预热 [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ==="
    )

    # 检查 GeoIP 数据库是否存在
    if not os.path.exists(GEOIP_CITY_DB):
        print(f"[error] City 数据库不存在: {GEOIP_CITY_DB}")
        sys.exit(1)

    # 清理损坏的缓存文件（0 字节 = 表未创建成功）
    if os.path.exists(DATABASE) and os.path.getsize(DATABASE) == 0:
        print("[warn] 检测到损坏的缓存，删除重建...")
        os.remove(DATABASE)

    print("[stats] 解析 Nginx 日志...")
    visitors = collect_unique_ips()
    if not visitors:
        print("[warn] 没有找到有效访问记录")
        return
    print(f"   找到 {len(visitors)} 个唯一 IP")

    conn = sqlite3.connect(DATABASE, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    ensure_geo_cache(conn)
    city_reader = geoip2.database.Reader(GEOIP_CITY_DB)
    asn_reader = (
        geoip2.database.Reader(GEOIP_ASN_DB)
        if os.path.exists(GEOIP_ASN_DB)
        else None
    )

    hit, miss, skip = 0, 0, 0

    # 遍历所有 IP，逐条查询并缓存
    for ip in visitors:
        # 跳过已缓存的 IP
        if get_cached_geo(conn, ip):
            hit += 1
            continue

        if is_private_ip(ip):
            skip += 1
            continue

        # 城市级地理查询
        try:
            resp = city_reader.city(ip)
            lat = resp.location.latitude
            lon = resp.location.longitude
            if lat is None or lon is None:
                skip += 1
                continue

            # 使用 GeoLite2 自带英文名，不做中文翻译
            country = resp.country.name or ""
            city = resp.city.name or ""
        except (geoip2.errors.AddressNotFoundError, Exception):
            skip += 1
            continue

        # ASN 查询
        asn_code = ""
        asn_org = ""
        if asn_reader:
            try:
                asn_resp = asn_reader.asn(ip)
                asn_code = (
                    f"AS{asn_resp.autonomous_system_number}"
                    if asn_resp.autonomous_system_number
                    else ""
                )
                asn_org = asn_resp.autonomous_system_organization or ""
            except (geoip2.errors.AddressNotFoundError, Exception):
                pass

        geo = {
            "country": country,
            "city": city,
            "latitude": lat,
            "longitude": lon,
            "isp": asn_org,
            "asn": asn_code,
        }
        cache_geo(conn, ip, geo)
        miss += 1

    conn.commit()
    conn.close()
    city_reader.close()
    if asn_reader:
        asn_reader.close()

    # 输出统计摘要
    total = len(visitors)
    print(f"\n[ok] 完成！")
    print(f"   总 IP 数:   {total}")
    print(f"   缓存命中:   {hit}")
    print(f"   新增缓存:   {miss}")
    print(f"   跳过:       {skip}")
    if total > 0:
        print(
            f"   缓存覆盖:   {hit + miss}/{total} "
            f"({(hit + miss) / total * 100:.1f}%)"
        )


def cmd_update() -> None:
    """更新 GeoLite2 数据库（原 update_geoip.py）"""
    print(f"=== GeoLite2 数据库更新 [{DATA_DIR}] ===")

    any_changed = False
    for name, cfg in DATABASES.items():
        if update_one(name, cfg):
            any_changed = True

    if not any_changed:
        print("\n所有数据库均已是最新")

    # 数据库更新后，旧的 geo_cache 可能已不准确，需要清理
    if any_changed:
        cache_file = os.path.join(DATA_DIR, "geo_cache.db")
        if cache_file.exists():
            cache_file.unlink()
            print(f"\n已清理旧缓存: {cache_file}")


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("cache", "update"):
        print(__doc__)
        sys.exit(1)
    if sys.argv[1] == "cache":
        cmd_cache()
    else:
        cmd_update()


if __name__ == "__main__":
    main()
