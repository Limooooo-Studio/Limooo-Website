# Limooo - 统一配置与公共工具
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

"""项目级统一配置与公共工具。

集中维护路径、语言、域名、数据库连接等常量，供 Flask 后端与 Pages 构建脚本复用。
Pages 侧对应配置见 ``functions/_lib/config.ts``。
"""

from __future__ import annotations

import json
import os
import re
import sqlite3

# ── 路径常量 ──────────────────────────────────────────────
# 仓库根目录（本文件位于 src/ 下，向上取一层）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
SOURCE_DIR = os.path.join(BASE_DIR, "src")
STATIC_DIR = os.path.join(SOURCE_DIR, "static")
TEMPLATES_DIR = os.path.join(SOURCE_DIR, "templates")
LOCALES_DIR = os.path.join(BASE_DIR, "locales")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
PREVIEW_DIR = os.path.join(BASE_DIR, "preview")

# 跨端共享配置的唯一事实源：config.py 与 build.py 生成 functions/_lib/config.ts
# 都从这里读取。修改域名 / 语言 / cookie / TTL / 公开主机时只改本文件。
CONTRACT_PATH = os.path.join(BASE_DIR, "config-contract.json")


def _load_contract() -> dict:
    """读取并返回跨端契约文档；解析失败时直接抛错，避免静默使用旧常量。"""
    try:
        with open(CONTRACT_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"无法读取配置契约 {CONTRACT_PATH}: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"配置契约格式错误（应为 JSON 对象）: {CONTRACT_PATH}")
    return data


CONTRACT = _load_contract()


def _contract_str(key: str) -> str:
    value = CONTRACT.get(key)
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"配置契约缺少字符串字段: {key}")
    return value


def _contract_int(key: str) -> int:
    value = CONTRACT.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RuntimeError(f"配置契约字段必须为正整数: {key}")
    return value


def _contract_str_list(key: str) -> list[str]:
    value = CONTRACT.get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise RuntimeError(f"配置契约字段必须为非空字符串列表: {key}")
    return value


# 全新部署时 data/ 可能尚不存在，import 即确保目录就绪
os.makedirs(DATA_DIR, exist_ok=True)

# 运行时数据库：与可丢的 geo_cache.db(IP 缓存)分开,避免部署清理误伤业务数据
DATABASE = os.path.join(DATA_DIR, "geo_cache.db")
APPLEID_DB = os.path.join(DATA_DIR, "appleid.db")
AUTH_DB = os.path.join(DATA_DIR, "auth.db")
BLOCKLIST_FILE = os.path.join(DATA_DIR, "blocklist.txt")
WHITELIST_FILE = os.path.join(DATA_DIR, "whitelist.txt")

# VPS 侧依赖的系统路径
NGINX_LOG = "/var/log/nginx/access.log"
SECRET_DIR = os.path.join(BASE_DIR, "secrets")
ENV_FILE = os.path.join(SECRET_DIR, "webauthn.env")

# ── Cloudflare 封禁同步（auto_block.py / sync-worker 共用约定） ──
CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
CF_LIST_NAME = "limooo_blocklist"
CF_BATCH_SIZE = 200
D1_DATABASE_ID = os.environ.get(
    "D1_DATABASE_ID", "e2f29d54-29c0-46af-938d-e13995a11d7f"
)

# ── 域名与子域 ────────────────────────────────────────────
ROOT_DOMAIN = _contract_str("root_domain")
BASE_URL = f"https://{ROOT_DOMAIN}"
WWW_HOST = f"www.{ROOT_DOMAIN}"
SERVICES_HOST = f"services.{ROOT_DOMAIN}"
CONTACT_HOST = f"contact.{ROOT_DOMAIN}"
VISITOR_HOST = f"visitor.{ROOT_DOMAIN}"
APPLEID_HOST = f"appleid.{ROOT_DOMAIN}"
REDIRECT_HOST = f"redirect.{ROOT_DOMAIN}"
REDIRECT_URL = f"https://{REDIRECT_HOST}/"
GATE_HOST = f"auth.{ROOT_DOMAIN}"
IDENTITY_HOST = f"identity.{ROOT_DOMAIN}"
IMAGES_HOST = f"images.{ROOT_DOMAIN}"
IMAGE_BASE_URL = f"https://{IMAGES_HOST}"
REDIRECT_BASE_URL = REDIRECT_URL
PUBLIC_HOSTS = tuple(_contract_str_list("public_hosts"))
SESSION_COOKIE_DOMAIN = f".{ROOT_DOMAIN}"

# ── 多语言 ────────────────────────────────────────────────
# 语言代码统一小写（与 Cloudflare Turnstile 的 language 参数格式一致）
SUPPORTED_LANGS = tuple(_contract_str_list("supported_langs"))
DEFAULT_LANG = _contract_str("default_lang")  # 无法判定时使用该语言
KEY_FALLBACK_LANG = _contract_str("key_fallback_lang")  # 缺失翻译键时回退语言
if DEFAULT_LANG not in SUPPORTED_LANGS or KEY_FALLBACK_LANG not in SUPPORTED_LANGS:
    raise RuntimeError("配置契约中的 default_lang / key_fallback_lang 必须属于 supported_langs")
LANG_COOKIE = _contract_str("lang_cookie")
LANG_COOKIE_MAX_AGE = _contract_int("lang_cookie_max_age")

# ── 人机验证门禁与登录（与 Pages 侧 functions/_lib/config.ts 保持一致） ──
GATE_COOKIE = _contract_str("gate_cookie")
SESSION_COOKIE = _contract_str("session_cookie")
PENDING_COOKIE = _contract_str("pending_cookie")
GATE_COOKIE_TTL = _contract_int("gate_ttl_seconds")
SESSION_TTL = _contract_int("session_ttl_seconds")
PENDING_TTL = _contract_int("pending_ttl_seconds")

# ── Apple ID ──────────────────────────────────────────────
APPLEID_DOMAIN = f"@{APPLEID_HOST}"
APPLEID_KEY_ETC = "/etc/limooo/appleid_encryption.key"
APPLEID_KEY_FILE = os.path.join(SECRET_DIR, "appleid_encryption.key")

# ── 统一跳转页预热图片（与 Page 端 manifest 及 Pages 中间件保持一致） ──
REDIRECT_PRELOAD_IMAGES = [
    f"{IMAGE_BASE_URL}/portfolio/IMG_0203.webp",
    f"{IMAGE_BASE_URL}/portfolio/IMG_0146.webp",
    f"{IMAGE_BASE_URL}/portfolio/IMG_0130.webp",
    f"{IMAGE_BASE_URL}/portfolio/IMG_0244.webp",
    f"{IMAGE_BASE_URL}/portfolio/IMG_0115.webp",
    f"{IMAGE_BASE_URL}/portfolio/IMG_0179.webp",
]

# ── 登录使用的 authentik 信息 ─────────────────────────────
AUTHENTIK_URL = f"https://{IDENTITY_HOST}"
AUTHENTIK_INTERNAL_URL = "http://127.0.0.1:9000"
AUTHENTIK_PROVIDER_SLUG = _contract_str("authentik_provider_slug")
AUTHENTIK_ADMIN_GROUPS = tuple(_contract_str_list("authentik_admin_groups"))

# ── Nginx combined 日志格式正则（用于从 access.log 中提取 IP、时间、请求行） ──
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
