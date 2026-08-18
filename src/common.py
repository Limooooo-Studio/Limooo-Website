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
共通模块

将 app.py 的路径常量、工具函数和数据库操作抽取到这里统一维护。
"""

import os
import re
import sqlite3

# ── 路径常量 ──────────────────────────────────────────────
# 仓库根目录（本文件位于 src/ 下，向上取一层）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
# 全新部署时 data/ 可能尚不存在，import 即确保目录就绪
os.makedirs(DATA_DIR, exist_ok=True)
DATABASE = os.path.join(DATA_DIR, "geo_cache.db")
# Apple ID 业务库:与可丢的 geo_cache.db(IP 缓存)分开,避免部署清理误伤业务数据
APPLEID_DB = os.path.join(DATA_DIR, "appleid.db")
NGINX_LOG = "/var/log/nginx/access.log"

# Nginx combined 日志格式正则（用于从 access.log 中提取 IP、时间、请求行）
LOG_PATTERN = re.compile(
    r'^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\d+)\s+(\S+)\s+"([^"]*)"\s+"([^"]*)"'
)


# ── 数据库连接工厂（解决 gunicorn 多 worker 写冲突） ──────
def get_geo_db() -> sqlite3.Connection:
    """创建带 WAL 模式和超时的 SQLite 连接，支持多 worker 并发"""
    conn = sqlite3.connect(DATABASE, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def get_appleid_db() -> sqlite3.Connection:
    """创建 Apple ID 业务库连接(独立于 geo_cache.db)"""
    conn = sqlite3.connect(APPLEID_DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.row_factory = sqlite3.Row
    return conn


# ── IP 工具 ───────────────────────────────────────────────
def is_private_ip(ip: str) -> bool:
    """判断 IP 是否为私有/回环地址，这类地址不需要 GeoIP 查询"""
    if ip in ("127.0.0.1", "localhost", "::1", "-"):
        return True
    if ip.startswith(("192.168.", "10.")):
        return True
    if ip.startswith(tuple(f"172.{n}." for n in range(16, 32))):
        return True
    return False


# ── 地理位置缓存数据库操作 ──────────────────────────────
def ensure_geo_cache(conn: sqlite3.Connection) -> None:
    """创建 geo_cache 表（如果不存在），并执行必要的 schema 迁移"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS geo_cache (
            ip         TEXT PRIMARY KEY,
            country    TEXT,
            city       TEXT,
            latitude   REAL,
            longitude  REAL,
            isp        TEXT,
            asn        TEXT,
            cached_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # 兼容旧版本：检查是否缺少 asn 列，如有需要则新增
    cols = {r[1] for r in conn.execute("PRAGMA table_info(geo_cache)").fetchall()}
    if "asn" not in cols:
        conn.execute("ALTER TABLE geo_cache ADD COLUMN asn TEXT")
    conn.commit()


def get_cached_geo(conn: sqlite3.Connection, ip: str) -> dict | None:
    """从缓存数据库中读取指定 IP 的地理位置信息"""
    row = conn.execute(
        "SELECT country, city, latitude, longitude, isp, asn FROM geo_cache WHERE ip = ?",
        (ip,),
    ).fetchone()
    if not row:
        return None
    # 用索引访问:调用方不一定设置了 row_factory=Row(sqlite3.Row 同样支持索引)
    return {
        "country": row[0],
        "city": row[1],
        "latitude": row[2],
        "longitude": row[3],
        "isp": row[4],
        "asn": row[5],
    }
