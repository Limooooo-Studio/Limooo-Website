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

import base64
import functools
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import urllib.parse
from datetime import datetime, timezone

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

import requests
from flask import Flask, Response, g, jsonify, redirect, render_template, request, session

from common import (
    BASE_DIR,
    DATA_DIR,
    DATABASE,
    LOG_PATTERN,
    NGINX_LOG,
    ensure_geo_cache,
    get_appleid_db,
    get_cached_geo,
    is_private_ip,
)

# ── Blocklist ──────────────────────────────────────────
# Load /24 prefixes from blocklist.txt (loaded once at startup)
def _load_blocked_prefixes() -> set[str]:
    prefixes = set()
    try:
        with open(os.path.join(DATA_DIR, "blocklist.txt")) as f:
            for line in f:
                line = line.strip()
                if not line.startswith("#") and line.endswith(".0/24"):
                    parts = line.split(".")
                    if len(parts) == 4:
                        prefixes.add(f"{parts[0]}.{parts[1]}.{parts[2]}")
    except FileNotFoundError:
        pass
    return prefixes

BLOCKED_SUBNETS: set[str] = _load_blocked_prefixes()
BLOCKED_IPS: set[str] = set()  # all merged into /24, kept for compatibility

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "src", "templates"),
    static_folder=os.path.join(BASE_DIR, "src", "static"),
)

SECRET_KEY_ETC = "/etc/limooo/flask_secret.key"
SECRET_KEY_FILE = os.path.join(BASE_DIR, "secrets", "flask_secret.key")

# 持久化 secret key（跨 gunicorn 重启保持 session 有效）
# 优先级:环境变量 FLASK_SECRET_KEY > /etc/limooo/(chmod 600) > 项目目录(兼容旧部署)
FLASK_SECRET_ENV = os.environ.get("FLASK_SECRET_KEY")
if FLASK_SECRET_ENV:
    app.secret_key = FLASK_SECRET_ENV
elif os.path.exists(SECRET_KEY_ETC):
    with open(SECRET_KEY_ETC, "r") as f:
        app.secret_key = f.read().strip()
elif os.path.exists(SECRET_KEY_FILE):
    with open(SECRET_KEY_FILE, "r") as f:
        app.secret_key = f.read().strip()
else:
    app.secret_key = secrets.token_hex(32)
    try:
        os.makedirs("/etc/limooo", exist_ok=True)
        with open(SECRET_KEY_ETC, "w") as f:
            f.write(app.secret_key)
        os.chmod(SECRET_KEY_ETC, 0o600)
    except OSError:
        # 无 /etc 写权限(本地开发)时退回项目目录
        with open(SECRET_KEY_FILE, "w") as f:
            f.write(app.secret_key)

app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_DOMAIN"] = ".limooo.cn"


# ── authentik OIDC ──────────────────────────────────────
AUTHENTIK_BASE = os.environ.get("AUTHENTIK_URL") or "https://identity.limooo.cn"
# 服务器内部访问地址（浏览器跳转走公网，token 请求走内网回环，
# 因为服务器无法回连自身公网 IP 的 443）
AUTHENTIK_INTERNAL = os.environ.get("AUTHENTIK_INTERNAL_URL") or "http://127.0.0.1:9000"
PROVIDER_SLUG = os.environ.get("AUTHENTIK_PROVIDER_SLUG") or "limooo"
CLIENT_ID = os.environ.get("AUTHENTIK_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("AUTHENTIK_CLIENT_SECRET", "")
SCOPE = "openid profile email groups"

# 管理员组名单(逗号分隔)。登录用户在 authentik 中被分到这些组即为 admin(可写)，
# 否则为 viewer(只读)。
ADMIN_GROUPS = {
    group.strip()
    for group in os.environ.get("AUTHENTIK_ADMIN_GROUPS", "authentik Admins").split(",")
    if group.strip()
}

AUTHORIZE_URL = f"{AUTHENTIK_BASE}/application/o/authorize/"
TOKEN_URL = f"{AUTHENTIK_INTERNAL}/application/o/token/"
LOGOUT_URL = f"{AUTHENTIK_BASE}/application/o/{PROVIDER_SLUG}/end-session/"


def build_auth_url(redirect_uri: str, state: str) -> str:
    """构建 authentik OIDC 授权 URL"""
    params = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": SCOPE,
        "state": state,
    })
    return f"{AUTHORIZE_URL}?{params}"


def process_callback(code: str, redirect_uri: str) -> dict | None:
    """用授权码兑换 token，返回 id_token claims 或 None"""
    data = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    try:
        resp = requests.post(TOKEN_URL, data=data, timeout=10)
        result = resp.json()
        if "id_token" in result:
            # 手动解析 JWT id_token 提取 claims（不需要额外库）
            payload_b64 = result["id_token"].split(".")[1]
            padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
            claims = json.loads(base64.urlsafe_b64decode(padded))
            return claims
        error = result.get("error_description", result.get("error", "Unknown error"))
        print(f"[authentik] Token acquisition failed: {error}", flush=True)
        return None
    except Exception as e:
        print(f"[authentik] Token request failed: {e}", flush=True)
        return None


def user_is_allowed(claims: dict) -> bool:
    """authentik 是门禁：能通过 authentik 认证的账号即允许访问"""
    return True


def user_role(claims: dict) -> str:
    """判断用户角色:admin(可写) / viewer(只读)。按 authentik 组判断。"""
    groups = claims.get("groups") or []
    if isinstance(groups, str):
        groups = [groups]
    return "admin" if any(g in ADMIN_GROUPS for g in groups) else "viewer"


def build_logout_url(next_url: str) -> str:
    """构建 authentik RP-Initiated Logout 地址"""
    return f"{LOGOUT_URL}?post_logout_redirect_uri={urllib.parse.quote(next_url)}"


# ── authentik backchannel logout ─────────────────────────
# authentik 的 OIDC provider 已配置 logout_method=backchannel:用户在任一
# 应用登出后,authentik 会 POST logout_token 到 provider 的 logout_uri。
# 本地 session(authed)与 authentik 会话独立,若不接收该通知,用户在
# identity 界面登出后本应用的 session 仍有效(退登了还能进)。
AUTH_DB = os.path.join(DATA_DIR, "auth.db")


def _get_auth_db() -> sqlite3.Connection:
    conn = sqlite3.connect(AUTH_DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _ensure_logout_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS logout_events (
            sub            TEXT PRIMARY KEY,
            logged_out_at  REAL NOT NULL
        )
    """)


def _record_logout(sub: str, ts: float) -> None:
    conn = _get_auth_db()
    try:
        _ensure_logout_table(conn)
        conn.execute(
            "INSERT OR REPLACE INTO logout_events (sub, logged_out_at) VALUES (?, ?)",
            (sub, ts),
        )
        conn.commit()
    except sqlite3.Error as e:
        app.logger.error(f"[backchannel] 记录登出失败: {e}")
    finally:
        conn.close()


def _last_logout_at(sub: str) -> float:
    conn = _get_auth_db()
    try:
        _ensure_logout_table(conn)
        row = conn.execute(
            "SELECT logged_out_at FROM logout_events WHERE sub = ?", (sub,)
        ).fetchone()
        return row[0] if row else 0.0
    except sqlite3.Error:
        return 0.0
    finally:
        conn.close()


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


_jwks_cache: dict = {"keys": None, "fetched_at": 0.0}


def _get_ak_jwks() -> list[dict]:
    """拉取 authentik provider 的 JWKS(验签 logout_token),每小时刷新"""
    if _jwks_cache["keys"] and time.time() - _jwks_cache["fetched_at"] < 3600:
        return _jwks_cache["keys"]
    try:
        resp = requests.get(
            f"{AUTHENTIK_INTERNAL}/application/o/{PROVIDER_SLUG}/jwks/", timeout=5
        )
        keys = resp.json().get("keys", [])
        if keys:
            _jwks_cache["keys"] = keys
            _jwks_cache["fetched_at"] = time.time()
    except Exception as e:
        app.logger.warning(f"[backchannel] 获取 JWKS 失败: {e}")
    return _jwks_cache["keys"] or []


def _verify_ak_token(token: str) -> dict | None:
    """校验 authentik logout_token 签名与客户端,返回 claims;失败返回 None"""
    try:
        header, payload, signature = token.split(".")
        hdr = json.loads(_b64decode(header))
        if hdr.get("alg") != "RS256":
            return None
        kid = hdr.get("kid")
        jwk = next((k for k in _get_ak_jwks() if k.get("kid") == kid), None)
        if jwk is None:
            app.logger.warning(f"[backchannel] 未找到匹配 JWK kid={kid}")
            return None
        n = int.from_bytes(_b64decode(jwk["n"]), "big")
        e = int.from_bytes(_b64decode(jwk["e"]), "big")
        pub = rsa.RSAPublicNumbers(e, n).public_key()
        pub.verify(
            _b64decode(signature),
            f"{header}.{payload}".encode(),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        claims = json.loads(_b64decode(payload))
    except Exception:
        return None
    if claims.get("aud") != CLIENT_ID:
        return None
    if claims.get("iss") and not str(claims["iss"]).endswith(
        f"/application/o/{PROVIDER_SLUG}/"
    ):
        return None
    return claims


@app.route("/logout/backchannel", methods=["POST"])
def backchannel_logout():
    """接收 authentik 的 backchannel logout_token,记录该 sub 已登出"""
    token = request.form.get("logout_token")
    if not token:
        return "", 400
    claims = _verify_ak_token(token)
    if not claims:
        app.logger.warning("[backchannel] logout_token 验签失败")
        return "", 400
    sub = claims.get("sub")
    if not sub:
        return "", 400
    _record_logout(sub, claims.get("iat") or time.time())
    app.logger.info(f"[backchannel] 记录登出 sub={sub}")
    return "", 200


def _session_logged_out() -> bool:
    """authentik 已登出该 sub 时,本地会话应视为失效(在会话建立之后登出才算)"""
    sub = session.get("sub")
    if not sub:
        return False
    last = _last_logout_at(sub)
    if not last:
        return False
    return last > (session.get("auth_at") or 0)


# ── 多语言支持 ──────────────────────────────────────────
# 语言代码统一小写（与 Cloudflare Turnstile 的 language 参数格式一致）
SUPPORTED_LANGS = ("zh-cn", "en-us", "ja-jp", "ko-kr")
DEFAULT_LANG = "en-us"  # 无法判定时默认英文（IP 地理检测的其他地区也归英文）
KEY_FALLBACK_LANG = "zh-cn"  # 缺失翻译键时回退中文原文
LANG_COOKIE = "user_lang_preference"
LOCALES_DIR = os.path.join(BASE_DIR, "locales")

_translations: dict[str, dict[str, str]] = {}


def _load_translations() -> None:
    """启动时把 locales/ 下所有语言 JSON 一次性读入内存"""
    for name in SUPPORTED_LANGS:
        path = os.path.join(LOCALES_DIR, f"{name}.json")
        try:
            with open(path, encoding="utf-8") as f:
                _translations[name] = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            app.logger.warning(f"[i18n] 语言文件缺失或损坏: {path}")
            _translations[name] = {}


def _detect_lang() -> str:
    """语言检测优先级: Cookie > Accept-Language(zh/en/ja/ko) > IP 地理位置"""
    cookie = request.cookies.get(LANG_COOKIE)
    if cookie and cookie.lower() in SUPPORTED_LANGS:
        return cookie.lower()

    accept = request.headers.get("Accept-Language", "")
    for part in accept.split(","):
        prefix = part.strip().split(";")[0].lower()
        if prefix.startswith("zh"):
            return "zh-cn"
        if prefix.startswith("en"):
            return "en-us"
        if prefix.startswith("ja"):
            return "ja-jp"
        if prefix.startswith("ko"):
            return "ko-kr"

    return DEFAULT_LANG


@app.before_request
def set_language() -> None:
    """每个请求前检测语言并存入 g.lang（须先于 block_banned_visitors 注册）"""
    g.lang = _detect_lang()


@app.after_request
def persist_detected_lang(resp: Response) -> Response:
    """首次访问无语言 cookie 时,把检测出的语言写回 cookie(.limooo.cn 全站共享),
    此后所有子域界面都固定使用该语言,不再随浏览器语言变化"""
    if LANG_COOKIE in request.cookies:
        return resp
    if request.path.startswith("/api/"):
        return resp  # 纯数据接口无需语言 cookie
    lang = getattr(g, "lang", None)
    if not lang:
        return resp
    if request.host.endswith("limooo.cn"):
        # 生产环境:跨子域共享,需要显式写 domain 属性
        resp.set_cookie(LANG_COOKIE, lang, max_age=31536000, path="/",
                        samesite="Lax", secure=True, domain=".limooo.cn")
    else:
        # 本地开发(localhost):仅当前域
        resp.set_cookie(LANG_COOKIE, lang, max_age=31536000, path="/",
                        samesite="Lax", secure=request.is_secure)
    return resp


@app.context_processor
def inject_i18n():
    """注入 _() 翻译函数与当前语言完整字典（供前端 JS 使用）"""
    def _(key: str, **kwargs) -> str:
        lang_dict = _translations.get(getattr(g, "lang", DEFAULT_LANG), {})
        if key in lang_dict:
            text = lang_dict[key]  # 空字符串是合法翻译值,不能用 or 回退
        else:
            text = _translations.get(KEY_FALLBACK_LANG, {}).get(key, key)
        if kwargs:
            try:
                return text.format(**kwargs)
            except (KeyError, IndexError):
                return text
        return text

    return {
        "_": _,
        "translations": _translations.get(getattr(g, "lang", DEFAULT_LANG), {}),
    }


def init_db() -> None:
    if os.path.exists(DATABASE) and os.path.getsize(DATABASE) == 0:
        os.remove(DATABASE)
        print(f"[init_db] 检测到损坏的缓存文件，已删除重建: {DATABASE}")

    conn = sqlite3.connect(DATABASE, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    ensure_geo_cache(conn)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS ip_whitelist (
            ip         TEXT PRIMARY KEY,
            added_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            source     TEXT DEFAULT 'microsoft'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS translation_cache (
            key       TEXT PRIMARY KEY,
            value     TEXT NOT NULL,
            cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE, timeout=10)
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA synchronous=NORMAL")
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_error=None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _is_whitelisted(ip: str) -> bool:
    """检查 IP 是否在白名单中，同时自动清理过期条目"""
    try:
        db = get_db()
        row = db.execute(
            "SELECT expires_at FROM ip_whitelist WHERE ip = ?",
            (ip,),
        ).fetchone()
        if row is None:
            return False
        if datetime.now(timezone.utc).timestamp() > float(row["expires_at"]):
            db.execute("DELETE FROM ip_whitelist WHERE ip = ?", (ip,))
            db.commit()
            return False
        return True
    except sqlite3.Error:
        return False


def _is_blocked(ip: str) -> str | None:
    """综合检查 IP 是否被封禁，返回封禁原因字符串或 None"""
    if _is_whitelisted(ip):
        return None
    if ip in BLOCKED_IPS:
        return "ip"
    prefix = ".".join(ip.split(".")[:3])
    if prefix in BLOCKED_SUBNETS:
        return "subnet"
    return None


@app.before_request
def block_banned_visitors():
    """
    全局请求过滤器：在每次请求前检查访客 IP 是否被封禁。
    管理后台认证路径放行，以便管理员从被封 IP 登录后自动加入白名单。
    """
    path = request.path
    if path.startswith("/visitor") or path.startswith("/api/appleid") or path.startswith("/login") or path.startswith("/appleid") or path.startswith("/logout"):
        return
    # 放行 hstspreload 官方检测器（Google Chrome HSTS preload 检查，封禁 ASN 会误伤）
    ua = request.headers.get("User-Agent", "")
    if ua.startswith("hstspreload-bot"):
        return
    ip = request.headers.get("X-Real-IP") or request.remote_addr
    if not ip or is_private_ip(ip):
        return
    reason = _is_blocked(ip)
    if reason:
        app.logger.warning(
            f"[blocked] 已拦截被封禁请求: {ip} (原因: {reason}) 路径: {request.path}"
        )
        return Response("Forbidden", status=403)


def _verify_token(token: str | None) -> bool:
    """验证签名 token 的合法性和有效期，无需共享状态"""
    if not token:
        return False
    try:
        padded = token + "=" * (4 - len(token) % 4) if len(token) % 4 else token
        decoded = base64.urlsafe_b64decode(padded).decode()
        expiry_str, sig = decoded.split(":", 1)
        expiry = int(expiry_str)
        if time.time() > expiry:
            return False
        expected = hmac.new(
            app.secret_key.encode(), expiry_str.encode(), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(sig, expected)
    except Exception:
        return False


def _require_auth() -> bool:
    if session.get("authed"):
        if _session_logged_out():
            session.clear()
            return False
        return True
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    return _verify_token(auth[7:])


def _require_admin() -> bool:
    """写操作权限:仅 admin 角色可写。Bearer 令牌(系统调用)视为管理员"""
    if session.get("role") == "admin":
        return True
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return _verify_token(auth[7:])
    return False


def login_required(f):
    """JSON API 登录校验装饰器：未登录返回 401"""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        if not _require_auth():
            return jsonify({"error": "未登录"}), 401
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    """JSON API 写操作权限：需登录且为 admin（Bearer 令牌视为管理员）"""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        if not _require_auth():
            return jsonify({"error": "未登录"}), 401
        if not _require_admin():
            return jsonify({"error": "只读账户，无写入权限"}), 403
        return f(*args, **kwargs)
    return wrapper


# ── 人机验证门禁（与 Cloudflare Pages 共用 __gate cookie，nginx auth_request 调用）──
GATE_COOKIE = "__gate"
GATE_HOST = "auth.limooo.cn"


def _gate_hmac_hex(key: str, payload: str) -> str:
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _gate_cookie_valid(value: str | None, key: str) -> bool:
    if not value or not key or "." not in value:
        return False
    payload, sig = value.rsplit(".", 1)
    if not payload.isdigit() or len(sig) != 64:
        return False
    if not hmac.compare_digest(sig, _gate_hmac_hex(key, payload)):
        return False
    return int(payload) > int(time.time())


@app.route("/__gate_check")
def gate_check():
    """nginx auth_request 内部端点：__gate 有效 → 204；无效 → 403（nginx error_page 转 302）"""
    key = os.environ.get("GATE_HMAC_KEY", "")
    if _gate_cookie_valid(request.cookies.get(GATE_COOKIE), key):
        return Response(status=204)
    return Response("Forbidden", status=403)


def parse_nginx_log(max_lines: int = 5000) -> list[dict]:
    """解析 Nginx access.log，提取最近访问者的 IP、路径、时间"""
    visitors: dict[str, dict] = {}
    try:
        with open(NGINX_LOG, "r", errors="ignore") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []

    for line in reversed(lines[-max_lines:]):
        m = LOG_PATTERN.match(line.strip())
        if not m:
            continue
        ip = m.group(1)
        time_str = m.group(2)
        request_line = m.group(3)
        status_code = m.group(4)
        if is_private_ip(ip):
            continue
        parts = request_line.split()
        path = parts[1] if len(parts) > 1 else ""
        if path.startswith(("/static", "/api/")):
            continue
        try:
            parsed_time = datetime.strptime(
                time_str.split()[0], "%d/%b/%Y:%H:%M:%S"
            )
        except ValueError:
            parsed_time = None
        if ip not in visitors:
            visitors[ip] = {
                "ip": ip,
                "last_time": parsed_time,
                "hosts": [],
                "paths": [],
                "statuses": {},
                "count": 0,
                "has_200": False,
            }
        v = visitors[ip]
        v["count"] += 1
        v["statuses"][status_code] = v["statuses"].get(status_code, 0) + 1
        if status_code == "200":
            v["has_200"] = True
        if parsed_time and (
            v["last_time"] is None or parsed_time > v["last_time"]
        ):
            v["last_time"] = parsed_time
        host = f"https://limooo.cn{path}"
        if host not in v["hosts"]:
            v["hosts"].append(host)
            if len(v["hosts"]) > 5:
                v["hosts"] = v["hosts"][:5]
        if path not in v["paths"]:
            v["paths"].append(path)
            if len(v["paths"]) > 3:
                v["paths"] = v["paths"][:3]
    return list(visitors.values())


@app.route("/api/i18n/<lang>")
def api_i18n(lang: str):
    """返回指定语言的完整翻译字典(读内存,供前端后台预取缓存)"""
    if lang not in SUPPORTED_LANGS:
        return jsonify({"error": "unsupported language"}), 404
    resp = jsonify(_translations.get(lang, {}))
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/services")
def services():
    return render_template("services.html")


@app.route("/contact")
def contact():
    return render_template("contact.html")


@app.route("/visitor")
def visitor():
    if not _require_auth():
        return redirect("/login?next=" + urllib.parse.quote(_browser_url()))
    return render_template("visitor.html")


# ── authentik 登录 ──────────────────────────


@app.route("/api/auth/status")
def api_auth_status():
    """查询当前登录状态"""
    return jsonify({
        "authed": session.get("authed", False),
        "user": session.get("user", None),
        "role": session.get("role", "viewer"),
    })


# ── 统一重定向页（redirect.limooo.cn）──────────────────
REDIRECT_HOST = "https://redirect.limooo.cn/"

# redirect 页预热的 limooo.cn 主站图片（与 base.html PAGE_MANIFEST['/'] 保持同步）
# 全部用裸域绝对 URL（资源统一走 https://images.limooo.cn/，不带 /static 前缀）
REDIRECT_PRELOAD_IMAGES = [
    "https://images.limooo.cn/portfolio/IMG_0203.webp",
    "https://images.limooo.cn/portfolio/IMG_0146.webp",
    "https://images.limooo.cn/portfolio/IMG_0130.webp",
    "https://images.limooo.cn/portfolio/IMG_0244.webp",
    "https://images.limooo.cn/portfolio/IMG_0115.webp",
    "https://images.limooo.cn/portfolio/IMG_0179.webp",
]


def _safe_next(url: str | None) -> str:
    """跳转目标校验：允许任意 https URL（含站外），拦截非 https 协议"""
    if not url:
        return "https://limooo.cn/"
    if not url.startswith("https://"):
        return "https://limooo.cn/"
    return url


def _is_limooo_target(url: str) -> bool:
    """跳转目标是否为 limooo.cn 主站（含 www）：是则预热主站图片"""
    if not url.startswith("https://"):
        return False
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return host in ("limooo.cn", "www.limooo.cn")


def _via_redirect(url: str) -> str:
    """把目标 URL 包装成经 redirect.limooo.cn 的跳转"""
    return REDIRECT_HOST + "?to=" + urllib.parse.quote(_safe_next(url), safe="")


def _browser_url() -> str:
    """浏览器地址栏的真实 URL（Nginx 会把 / 代理成 /visitor 或 /appleid，用 X-Original-URI 还原）"""
    orig = request.headers.get("X-Original-URI")
    if orig:
        return request.host_url.rstrip("/") + orig
    return request.url


@app.route("/r")
def redirect_page():
    """中间跳转页：显示 Redirecting 后跳到目标（任意 https URL，含站外）"""
    to = _safe_next(request.args.get("to"))
    app.logger.info(f"[redirect] to={to} | referer={request.headers.get('Referer', '')[:100]}")
    preload = _is_limooo_target(to)
    return render_template(
        "redirect.html",
        to=to,
        preload=preload,
        preload_images=REDIRECT_PRELOAD_IMAGES if preload else [],
    )


@app.route("/login")
def login():
    """重定向到 authentik 登录页"""
    next_url = _safe_next(request.args.get("next"))
    state = secrets.token_urlsafe(16)
    # 跳转目标按 state 存成 dict：各子域共享同一 session cookie(见
    # SESSION_COOKIE_DOMAIN)，单值 oauth_next 会被并发标签互相覆盖，
    # 导致登录后跳错站。以 state 为 key 让每个流程独立。
    pending = session.get("oauth_pending") or {}
    pending[state] = next_url
    if len(pending) > 8:
        pending = dict(list(pending.items())[-8:])
    session["oauth_pending"] = pending

    redirect_uri = request.host_url.rstrip("/") + "/login/callback"
    auth_url = build_auth_url(redirect_uri, state)
    app.logger.info(f"[login] next={next_url} | host={request.host}")
    return redirect(auth_url)


@app.route("/login/callback")
def login_callback():
    """authentik 登录回调处理"""
    code = request.args.get("code")
    state = request.args.get("state")

    # 用回调带回的 state 取回本次流程的跳转目标。state 不匹配说明流程
    # 已过期/被盗用/被并发流程覆盖，拒绝而不是用 session 残留值误跳。
    pending = session.get("oauth_pending") or {}
    next_url = pending.pop(state, None)
    session["oauth_pending"] = pending
    if next_url is None:
        app.logger.warning(f"[callback] state 不匹配，拒绝: {state!r}")
        return redirect(_via_redirect("https://limooo.cn/?error=bad_state"))

    if not code:
        return redirect(_via_redirect(next_url + "?error=no_code"))

    redirect_uri = request.host_url.rstrip("/") + "/login/callback"
    claims = process_callback(code, redirect_uri)

    if not claims:
        return redirect(_via_redirect(next_url + "?error=auth_failed"))

    if not user_is_allowed(claims):
        return redirect(_via_redirect(next_url + "?error=not_allowed"))

    # 登录成功
    session["authed"] = True
    session["sub"] = claims.get("sub")
    session["auth_at"] = time.time()
    user_email = claims.get("preferred_username") or claims.get("email", "")
    user_name = claims.get("name", user_email)
    session["user"] = {"email": user_email, "name": user_name}
    session["role"] = user_role(claims)
    session.permanent = True
    app.logger.info(f"[callback] next={next_url} | role={session['role']}")

    return redirect(_via_redirect(next_url))


@app.route("/logout")
def logout():
    """登出：清除本地 session，重定向到 authentik 登出"""
    session.pop("authed", None)
    session.pop("user", None)
    next_url = request.args.get("next", request.host_url)
    return redirect(build_logout_url(_via_redirect(next_url)))


# ── Apple ID Manager ──────────────────────────────────


def _init_appleid_db() -> None:
    conn = get_appleid_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS apple_accounts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            email       TEXT    NOT NULL UNIQUE,
            password    TEXT    NOT NULL,
            notes       TEXT    DEFAULT '',
            sort_order  INTEGER DEFAULT 0,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    # 迁移：旧表没有 sort_order 列时添加
    cols = {r[1] for r in conn.execute("PRAGMA table_info(apple_accounts)").fetchall()}
    if "sort_order" not in cols:
        conn.execute("ALTER TABLE apple_accounts ADD COLUMN sort_order INTEGER DEFAULT 0")
        conn.commit()
    conn.close()


def _migrate_appleid_from_geo_cache() -> None:
    """一次性迁移:把旧 geo_cache.db 里的 apple_accounts 复制到新 appleid.db。

    仅在 appleid.db 无数据、旧库有数据时执行,幂等。
    """
    dst = get_appleid_db()
    n_dst = dst.execute("SELECT COUNT(*) FROM apple_accounts").fetchone()[0]
    if n_dst > 0:
        dst.close()
        return
    try:
        src = sqlite3.connect(DATABASE, timeout=10)
        src.row_factory = sqlite3.Row
        rows = src.execute("SELECT * FROM apple_accounts").fetchall()
    except sqlite3.Error:
        src.close()
        dst.close()
        return
    src.close()
    if not rows:
        dst.close()
        return
    for r in rows:
        dst.execute(
            "INSERT OR IGNORE INTO apple_accounts (id, email, password, notes, sort_order, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (r["id"], r["email"], r["password"], r["notes"], r["sort_order"], r["created_at"], r["updated_at"]),
        )
    dst.commit()
    dst.close()
    print(f"[appleid] 已从 geo_cache.db 迁移 {len(rows)} 条 Apple ID 账户到 appleid.db")


# ── Apple ID 密码加密 ──────────────────────────────
APPLEID_KEY_ETC = "/etc/limooo/appleid_encryption.key"
APPLEID_KEY_FILE = os.path.join(BASE_DIR, "secrets", "appleid_encryption.key")

def _get_appleid_cipher():
    """获取 Fernet 加密器，密钥优先级:环境变量 > /etc/limooo/ > 项目目录(兼容旧部署)"""
    env_key = os.environ.get("APPLEID_ENCRYPTION_KEY")
    if env_key:
        return Fernet(env_key.encode())
    for path in (APPLEID_KEY_ETC, APPLEID_KEY_FILE):
        if os.path.exists(path):
            with open(path, "rb") as f:
                return Fernet(f.read())
    key = Fernet.generate_key()
    try:
        os.makedirs("/etc/limooo", exist_ok=True)
        with open(APPLEID_KEY_ETC, "wb") as f:
            f.write(key)
        os.chmod(APPLEID_KEY_ETC, 0o600)
    except OSError:
        # 无 /etc 写权限(本地开发)时退回项目目录
        with open(APPLEID_KEY_FILE, "wb") as f:
            f.write(key)
    return Fernet(key)

def _mask_password(pw: str) -> str:
    """返回脱敏密码：不显示明文，全部以圆点代替"""
    pw = pw or ""
    return "·" * len(pw)


@app.route("/appleid")
def appleid():
    if not _require_auth():
        return redirect("/login?next=" + urllib.parse.quote(_browser_url()))
    return render_template("appleid.html")


@app.route("/api/appleid/accounts", methods=["GET"])
@login_required
def api_appleid_list():
    db = get_appleid_db()
    cipher = _get_appleid_cipher()
    rows = db.execute(
        "SELECT id, email, password, notes, created_at, updated_at FROM apple_accounts ORDER BY sort_order, email"
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        try:
            plain = cipher.decrypt(d["password"].encode()).decode()
        except Exception:
            plain = d["password"]  # 兼容旧明文数据
        d["password"] = _mask_password(plain)
        result.append(d)
    return jsonify(result)


# Apple ID 账户邮箱固定域名(前端只填前缀,后端兜底规范化)
APPLEID_DOMAIN = "@appleid.limooo.cn"


def _normalize_appleid_email(raw: str) -> str:
    """邮箱统一为 xxx@appleid.limooo.cn:去掉输入里的 @ 后缀,只留前缀"""
    return raw.strip().split("@", 1)[0] + APPLEID_DOMAIN


@app.route("/api/appleid/accounts", methods=["POST"])
@admin_required
def api_appleid_add():
    data = request.get_json()
    if not data or not data.get("email") or not data.get("password"):
        return jsonify({"error": "邮箱和密码不能为空"}), 400
    cipher = _get_appleid_cipher()
    encrypted = cipher.encrypt(data["password"].encode()).decode()
    email = _normalize_appleid_email(data["email"])
    try:
        db = get_appleid_db()
        max_order = db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM apple_accounts").fetchone()[0]
        db.execute(
            "INSERT INTO apple_accounts (email, password, notes, sort_order) VALUES (?, ?, ?, ?)",
            (email, encrypted, data.get("notes", ""), max_order),
        )
        db.commit()
        return jsonify({"status": "ok"})
    except sqlite3.IntegrityError:
        return jsonify({"error": "该邮箱已存在"}), 409


@app.route("/api/appleid/reorder", methods=["PUT"])
@admin_required
def api_appleid_reorder():
    data = request.get_json()
    order = data.get("order", [])
    db = get_appleid_db()
    for i, account_id in enumerate(order):
        db.execute(
            "UPDATE apple_accounts SET sort_order = ? WHERE id = ?",
            (i, account_id),
        )
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/appleid/accounts/<int:account_id>", methods=["PUT"])
@admin_required
def api_appleid_update(account_id):
    data = request.get_json()
    db = get_appleid_db()
    password = data.get("password", "")
    if data.get("password_changed", False):
        cipher = _get_appleid_cipher()
        password = cipher.encrypt(password.encode()).decode()
    else:
        # 未修改密码，保持原有加密值
        existing = db.execute(
            "SELECT password FROM apple_accounts WHERE id = ?", (account_id,)
        ).fetchone()
        if existing:
            password = existing["password"]
    db.execute(
        "UPDATE apple_accounts SET email = ?, password = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (_normalize_appleid_email(data.get("email", "")), password, data.get("notes", ""), account_id),
    )
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/appleid/accounts/<int:account_id>/reveal", methods=["POST"])
@login_required
def api_appleid_reveal(account_id):
    """临时获取明文密码（需已登录），返回一次后即丢弃"""
    db = get_appleid_db()
    row = db.execute(
        "SELECT password FROM apple_accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if not row:
        return jsonify({"error": "未找到"}), 404
    cipher = _get_appleid_cipher()
    try:
        plain = cipher.decrypt(row["password"].encode()).decode()
    except Exception:
        plain = row["password"]
    return jsonify({"password": plain})


@app.route("/api/appleid/accounts/<int:account_id>", methods=["DELETE"])
@admin_required
def api_appleid_delete(account_id):
    db = get_appleid_db()
    db.execute("DELETE FROM apple_accounts WHERE id = ?", (account_id,))
    db.commit()
    return jsonify({"status": "ok"})


# ── 初始化 Apple ID 表 ────────────────────────────────
_init_appleid_db()
_migrate_appleid_from_geo_cache()


@app.route("/api/visitors")
@login_required
def api_visitors():
    """获取访客列表（需已登录），支持按状态码过滤"""
    status_filter = request.args.get("status", "all")

    logs = parse_nginx_log()
    markers: list[dict] = []
    countries: set[str] = set()
    status_counts: dict[str, int] = {}
    total_requests = 0
    db = get_db()

    for v in logs:
        total_requests += v["count"]
        for code, cnt in v["statuses"].items():
            status_counts[code] = status_counts.get(code, 0) + cnt
        if status_filter != "all" and status_filter not in v["statuses"]:
            continue
        geo = get_cached_geo(db, v["ip"])
        time_str = (
            v["last_time"].strftime("%Y-%m-%d %H:%M:%S") if v["last_time"] else None
        )
        entry = {
            "ip": v["ip"],
            "country": geo.get("country") if geo else None,
            "city": geo.get("city") if geo else None,
            "latitude": geo.get("latitude") if geo else None,
            "longitude": geo.get("longitude") if geo else None,
            "isp": geo.get("isp") if geo else None,
            "asn": geo.get("asn") if geo else None,
            "hosts": v["hosts"],
            "paths": v["paths"],
            "statuses": v["statuses"],
            "count": v["count"],
            "has_200": v["has_200"],
            "last_time": time_str,
        }
        markers.append(entry)
        if geo and geo.get("country"):
            countries.add(geo["country"])

    markers.sort(key=lambda x: x.get("last_time") or "", reverse=True)

    return jsonify({
        "stats": {
            "total_ips": len(logs),
            "total_requests": total_requests,
            "countries": len(countries),
        },
        "status_counts": status_counts,
        "markers": markers,
    })


init_db()
_load_translations()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
