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

"""VPS 最小运行时。

公开页面、登录、Apple ID、访客统计等已迁移到 Cloudflare Pages Functions。
本模块只保留 VPS 无法迁移或仍被 Nginx/auth 依赖的能力：

- authentik backchannel logout（必须由 authentik POST 到源站）
- Nginx auth_request 调用的 __gate_check
- 统一安全响应头与结构化事件日志
- 构建/本地模板渲染所需的 i18n 上下文
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
import requests
from flask import Flask, Response, g, request

from config import (
    AUTHENTIK_INTERNAL_URL,
    AUTHENTIK_PROVIDER_SLUG,
    AUTHENTIK_URL,
    BASE_DIR,
    BUILD_MODE,
    DATA_DIR,
    DEFAULT_LANG,
    GATE_COOKIE,
    GATE_HOST,
    IMAGE_ASSET_BASE_URL,
    IMAGE_WATERMARK_BASE_URL,
    KEY_FALLBACK_LANG,
    LOCALES_DIR,
    SESSION_COOKIE_DOMAIN,
    STATIC_DIR,
    SUPPORTED_LANGS,
    TEMPLATES_DIR,
)


# ── Flask 应用 ───────────────────────────────────────
app = Flask(
    __name__,
    template_folder=TEMPLATES_DIR,
    static_folder=STATIC_DIR,
)

SECRET_KEY_ETC = "/etc/limooo/flask_secret.key"
SECRET_KEY_FILE = os.path.join(BASE_DIR, "secrets", "flask_secret.key")

if BUILD_MODE:
    app.secret_key = ""
else:
    env_key = os.environ.get("FLASK_SECRET_KEY")
    if env_key:
        app.secret_key = env_key
    elif os.path.exists(SECRET_KEY_ETC):
        with open(SECRET_KEY_ETC, "r", encoding="utf-8") as f:
            app.secret_key = f.read().strip()
    elif os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, "r", encoding="utf-8") as f:
            app.secret_key = f.read().strip()
    else:
        app.secret_key = secrets.token_hex(32)
        try:
            os.makedirs("/etc/limooo", exist_ok=True)
            with open(SECRET_KEY_ETC, "w", encoding="utf-8") as f:
                f.write(app.secret_key)
            os.chmod(SECRET_KEY_ETC, 0o600)
        except OSError:
            with open(SECRET_KEY_FILE, "w", encoding="utf-8") as f:
                f.write(app.secret_key)

app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_DOMAIN"] = SESSION_COOKIE_DOMAIN


# ── 统一安全响应头（docs/05；唯一文案源 ops/security-headers.json） ──
def _load_security_headers() -> dict[str, str]:
    path = os.path.join(BASE_DIR, "ops", "security-headers.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except (OSError, json.JSONDecodeError):
        app.logger.warning(f"[security] 无法读取安全响应头配置: {path}")
    return {}


SECURITY_HEADERS: dict[str, str] = _load_security_headers()


@app.after_request
def add_security_headers(resp: Response) -> Response:
    """统一安全响应头；API 只需 X-Content-Type-Options，不套 CSP。"""
    if request.path.startswith("/api/"):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        return resp
    for name, value in SECURITY_HEADERS.items():
        resp.headers.setdefault(name, value)
    return resp


# ── 统一结构化事件日志（docs/06；字段与 functions/_lib/logging.ts 一致） ──
def _event_ip_hash(ip: str) -> str:
    key = str(app.secret_key or "")
    if not ip or not key:
        return ""
    return hmac.new(key.encode(), ip.encode(), hashlib.sha256).hexdigest()[:16]


def log_event(
    event: str,
    *,
    outcome: str = "",
    status: int = 0,
    message: str = "",
    path: str = "",
    method: str = "",
    host: str = "",
    duration_ms: int = 0,
    ip: str = "",
) -> None:
    """输出一行完整 JSON；日志失败不允许影响业务请求。"""
    try:
        request_id = request.headers.get("CF-Ray", "") or f"flask-{secrets.token_hex(8)}"
        cur_host = host or getattr(request, "host", "")
        cur_path = path or getattr(request, "path", "")
        cur_method = method or getattr(request, "method", "")
        cur_ip = ip or request.headers.get("CF-Connecting-IP") or request.remote_addr or ""
        cur_country = request.headers.get("CF-IPCountry", "")
    except Exception:  # noqa: BLE001 - 日志兜底，不影响业务
        request_id, cur_host, cur_path, cur_method, cur_ip, cur_country = "", "", "", "", "", ""
    payload = {
        "event": event,
        "ts": int(time.time()),
        "request_id": request_id,
        "host": cur_host,
        "path": cur_path,
        "method": cur_method,
        "status": status,
        "outcome": outcome,
        "ip_hash": _event_ip_hash(cur_ip),
        "country": cur_country,
        "duration_ms": duration_ms,
        "message": message,
    }
    try:
        app.logger.info(json.dumps(payload, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        pass


# ── authentik backchannel logout ─────────────────────
AUTHENTIK_BASE = os.environ.get("AUTHENTIK_URL") or AUTHENTIK_URL
AUTHENTIK_INTERNAL = (
    os.environ.get("AUTHENTIK_INTERNAL_URL") or AUTHENTIK_INTERNAL_URL
)
PROVIDER_SLUG = os.environ.get("AUTHENTIK_PROVIDER_SLUG") or AUTHENTIK_PROVIDER_SLUG
CLIENT_ID = os.environ.get("AUTHENTIK_CLIENT_ID", "")
AUTH_DB = os.path.join(DATA_DIR, "auth.db")


def _get_auth_db() -> sqlite3.Connection:
    conn = sqlite3.connect(AUTH_DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _ensure_logout_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS logout_events (
            sub            TEXT PRIMARY KEY,
            logged_out_at  REAL NOT NULL
        )
        """
    )


def _record_logout(sub: str, ts: float) -> None:
    conn = _get_auth_db()
    try:
        _ensure_logout_table(conn)
        conn.execute(
            "INSERT OR REPLACE INTO logout_events (sub, logged_out_at) VALUES (?, ?)",
            (sub, ts),
        )
        conn.commit()
    except sqlite3.Error as exc:
        log_event("backchannel_logout_error", outcome="failed", message=str(exc))
    finally:
        conn.close()


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


_jwks_cache: dict = {"keys": None, "fetched_at": 0.0}


def _get_ak_jwks() -> list[dict]:
    """拉取 authentik provider 的 JWKS（验签 logout_token），每小时刷新。"""
    if _jwks_cache["keys"] and time.time() - _jwks_cache["fetched_at"] < 3600:
        return _jwks_cache["keys"]
    try:
        resp = requests.get(
            f"{AUTHENTIK_INTERNAL}/application/o/{PROVIDER_SLUG}/jwks/",
            timeout=5,
        )
        keys = resp.json().get("keys", [])
        if keys:
            _jwks_cache["keys"] = keys
            _jwks_cache["fetched_at"] = time.time()
    except Exception as exc:  # noqa: BLE001
        log_event("jwks_fetch_error", outcome="failed", message=str(exc))
    return _jwks_cache["keys"] or []


def _verify_ak_token(token: str) -> dict | None:
    """校验 authentik logout_token 签名与客户端；失败返回 None。"""
    try:
        header, payload, signature = token.split(".")
        hdr = json.loads(_b64decode(header))
        if hdr.get("alg") != "RS256":
            return None
        kid = hdr.get("kid")
        jwk = next((k for k in _get_ak_jwks() if k.get("kid") == kid), None)
        if jwk is None:
            log_event(
                "logout_token_verify_error",
                outcome="failed",
                message=f"kid={kid}",
            )
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
    except Exception:  # noqa: BLE001
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
    """接收 authentik 的 backchannel logout_token，记录该 sub 已登出。"""
    token = request.form.get("logout_token")
    if not token:
        log_event(
            "backchannel_logout",
            outcome="failed",
            status=400,
            message="missing_token",
        )
        return "", 400
    claims = _verify_ak_token(token)
    if not claims:
        log_event(
            "backchannel_logout",
            outcome="failed",
            status=400,
            message="invalid_token",
        )
        return "", 400
    sub = claims.get("sub")
    if not sub:
        log_event(
            "backchannel_logout",
            outcome="failed",
            status=400,
            message="missing_sub",
        )
        return "", 400
    _record_logout(sub, claims.get("iat") or time.time())
    log_event(
        "backchannel_logout",
        outcome="ok",
        status=200,
        message="accepted",
    )
    return "", 200


# ── Nginx auth_request 门禁校验 ──────────────────────
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
    """nginx auth_request 内部端点：__gate 有效 → 204；无效 → 403。"""
    key = os.environ.get("GATE_HMAC_KEY", "")
    if _gate_cookie_valid(request.cookies.get(GATE_COOKIE), key):
        return Response(status=204)
    return Response("Forbidden", status=403)


# ── 模板渲染 i18n（构建与本地预览仍依赖） ─────────────
_translations: dict[str, dict[str, str]] = {}


def _load_translations() -> None:
    """启动时把 locales/ 下所有语言 JSON 一次性读入内存。"""
    for lang in SUPPORTED_LANGS:
        path = os.path.join(LOCALES_DIR, f"{lang}.json")
        try:
            with open(path, encoding="utf-8") as f:
                _translations[lang] = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            log_event("i18n_load_error", outcome="failed", message=f"{path}: {exc}")
            _translations[lang] = {}


@app.context_processor
def inject_i18n():
    """注入翻译函数与当前语言字典，供 Jinja 模板使用。"""

    def _(*, key: str, **kwargs: object) -> str:
        lang = getattr(g, "lang", DEFAULT_LANG)
        value = _translations.get(lang, {}).get(
            key,
            _translations.get(KEY_FALLBACK_LANG, {}).get(key, key),
        )
        if kwargs and isinstance(value, str):
            try:
                return value.format(**kwargs)
            except (KeyError, IndexError, ValueError):
                return value
        return value

    lang = getattr(g, "lang", DEFAULT_LANG)
    return {
        "_": lambda key, **kwargs: _(key=key, **kwargs),
        "translations": _translations.get(lang, {}),
        "gate_url": f"https://{GATE_HOST}/__gate",
        "image_asset_base": IMAGE_ASSET_BASE_URL,
        "image_watermark_base": IMAGE_WATERMARK_BASE_URL,
    }


if not BUILD_MODE:
    _load_translations()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
