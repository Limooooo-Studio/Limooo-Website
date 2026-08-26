#!/usr/bin/env python3

# Limooo - 健康检查与告警（docs/06）
#
# 读取 D1 events / visitors / ray_log 并在阈值超限时发送 SMTP 告警。
# 只连接 Cloudflare API（使用服务器 secrets/webauthn.env 中的凭据），
# 不读取或输出密钥/token 值；邮件走 SMTP 服务商，不使用本机 MTA。

from __future__ import annotations

import argparse
import json
import os
import smtplib
import sys
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from config import CLOUDFLARE_API_BASE, D1_DATABASE_ID, DATA_DIR, ENV_FILE  # noqa: E402

QUERY_FILE = ROOT / "ops" / "health_queries.sql"
SMTP_ENV_FILE = ROOT / "secrets" / "smtp-relay.env"
HEALTH_LOG = Path(DATA_DIR) / "health_alerts.log"
STATE_FILE = Path(DATA_DIR) / "health_alerts.state"

GATE_FAILURE_RATE_THRESHOLD = float(
    os.environ.get("HEALTH_GATE_FAILURE_RATE_THRESHOLD", "10.0")
)
GATE_UNAVAILABLE_THRESHOLD = int(
    os.environ.get("HEALTH_GATE_UNAVAILABLE_THRESHOLD", "5")
)
LOGIN_FAILURE_RATE_THRESHOLD = float(
    os.environ.get("HEALTH_LOGIN_FAILURE_RATE_THRESHOLD", "10.0")
)
D1_WRITE_ERROR_THRESHOLD = int(
    os.environ.get("HEALTH_D1_WRITE_ERROR_THRESHOLD", "0")
)
VISITOR_DROP_THRESHOLD = float(
    os.environ.get("HEALTH_VISITOR_DROP_THRESHOLD", "50.0")
)
ALERT_COOLDOWN_SECONDS = int(
    os.environ.get("HEALTH_ALERT_COOLDOWN_SECONDS", "3600")
)


def load_env(*paths: str | Path) -> dict[str, str]:
    """读取 env 文件；文件不存在时返回空字典，绝不回显值。"""
    result: dict[str, str] = {}
    for raw_path in paths:
        path = Path(raw_path)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


def env_value(env: dict[str, str], *names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
        value = env.get(name)
        if value:
            return value
    return default


def cloudflare_config(env: dict[str, str]) -> dict[str, str]:
    return {
        "token": env_value(env, "CLOUDFLARE_API_TOKEN"),
        "account_id": env_value(env, "CLOUDFLARE_ACCOUNT_ID"),
        "database_id": env_value(env, "D1_DATABASE_ID", default=D1_DATABASE_ID),
    }


def d1_query(cfg: dict[str, str], sql: str) -> list[dict[str, Any]]:
    token = cfg["token"]
    account_id = cfg["account_id"]
    database_id = cfg["database_id"]
    if not token or not account_id or not database_id:
        raise RuntimeError("Cloudflare / D1 配置缺失")
    url = (
        f"{CLOUDFLARE_API_BASE}/accounts/{account_id}/d1/database/{database_id}/query"
    )
    body = json.dumps({"sql": sql}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"D1 HTTP {exc.code}: {detail}") from exc
    if not data.get("success"):
        raise RuntimeError(f"D1 API 返回失败: {str(data)[:300]}")
    results = data.get("result") or []
    if not results:
        return []
    first = results[0] or {}
    if not first.get("success"):
        raise RuntimeError(f"D1 查询失败: {str(first)[:300]}")
    return first.get("results") or []


def _schema_statements() -> list[str]:
    """与 ops/migrations/003_events.sql 保持一致的幂等 DDL。"""
    return [
        """
        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event       TEXT    NOT NULL,
            ts          INTEGER NOT NULL DEFAULT (unixepoch()),
            request_id  TEXT    DEFAULT '',
            host        TEXT    DEFAULT '',
            path        TEXT    DEFAULT '',
            method      TEXT    DEFAULT '',
            status      INTEGER DEFAULT 0,
            outcome     TEXT    DEFAULT '',
            ip_hash     TEXT    DEFAULT '',
            country     TEXT    DEFAULT '',
            duration_ms INTEGER DEFAULT 0,
            message     TEXT    DEFAULT ''
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_events_ts_event ON events (ts, event)",
        "CREATE INDEX IF NOT EXISTS idx_events_event_outcome_ts ON events (event, outcome, ts)",
        "CREATE INDEX IF NOT EXISTS idx_events_request_id ON events (request_id)",
    ]


def ensure_schema(cfg: dict[str, str]) -> None:
    for sql in _schema_statements():
        d1_query(cfg, sql)


def load_queries(path: Path = QUERY_FILE) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    queries: dict[str, str] = {}
    current: str | None = None
    lines: list[str] = []
    for line in text.splitlines():
        if line.startswith("-- name:"):
            if current is not None:
                queries[current] = "\n".join(lines).strip().rstrip(";").strip()
            current = line.split(":", 1)[1].strip()
            lines = []
        elif current is not None:
            lines.append(line)
    if current is not None:
        queries[current] = "\n".join(lines).strip().rstrip(";").strip()
    return queries


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def evaluate_metrics(data: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    gate_row = (data.get("gate_verify_summary_1h") or [{}])[0]
    login_row = (data.get("login_callback_summary_1h") or [{}])[0]
    gate_ok = _as_int(gate_row.get("ok"))
    gate_failed = _as_int(gate_row.get("failed"))
    gate_unavailable = _as_int(gate_row.get("unavailable"))
    gate_total = _as_int(gate_row.get("total"))
    login_ok = _as_int(login_row.get("ok"))
    login_failed = _as_int(login_row.get("failed"))
    login_total = _as_int(login_row.get("total"))
    block_count = _as_int((data.get("block_match_count_1h") or [{}])[0].get("count"))
    ray_count = _as_int((data.get("ray_request_count_1h") or [{}])[0].get("count"))
    d1_errors = _as_int((data.get("d1_write_errors_24h") or [{}])[0].get("count"))
    trend_row = (data.get("visitor_trend_1h") or [{}])[0]
    current_hour = _as_int(trend_row.get("current_hour"))
    previous_hour = _as_int(trend_row.get("previous_hour"))

    gate_failure_rate = (
        (gate_failed + gate_unavailable) / gate_total * 100.0 if gate_total else 0.0
    )
    login_failure_rate = (
        login_failed / login_total * 100.0 if login_total else 0.0
    )
    block_rate = block_count / ray_count * 100.0 if ray_count else 0.0
    visitor_drop = (
        max(0.0, (previous_hour - current_hour) / previous_hour * 100.0)
        if previous_hour
        else 0.0
    )

    alerts: list[dict[str, Any]] = []
    if gate_total and gate_failure_rate > GATE_FAILURE_RATE_THRESHOLD:
        alerts.append({
            "key": "gate_failure_rate",
            "message": (
                f"门禁验证失败率 {gate_failure_rate:.2f}% "
                f"(> {GATE_FAILURE_RATE_THRESHOLD:.2f}%)"
            ),
        })
    if gate_unavailable > GATE_UNAVAILABLE_THRESHOLD:
        alerts.append({
            "key": "gate_unavailable",
            "message": (
                f"门禁不可用次数 {gate_unavailable} "
                f"(> {GATE_UNAVAILABLE_THRESHOLD})"
            ),
        })
    if login_total and login_failure_rate > LOGIN_FAILURE_RATE_THRESHOLD:
        alerts.append({
            "key": "login_failure_rate",
            "message": (
                f"登录失败率 {login_failure_rate:.2f}% "
                f"(> {LOGIN_FAILURE_RATE_THRESHOLD:.2f}%)"
            ),
        })
    if d1_errors > D1_WRITE_ERROR_THRESHOLD:
        alerts.append({
            "key": "d1_write_errors",
            "message": f"D1 写入失败事件 {d1_errors} (> {D1_WRITE_ERROR_THRESHOLD})",
        })
    if previous_hour and visitor_drop > VISITOR_DROP_THRESHOLD:
        alerts.append({
            "key": "visitor_drop",
            "message": (
                f"访客量下降 {visitor_drop:.2f}% "
                f"(> {VISITOR_DROP_THRESHOLD:.2f}%)"
            ),
        })

    return {
        "gate_verify_1h": {
            "ok": gate_ok,
            "failed": gate_failed,
            "unavailable": gate_unavailable,
            "total": gate_total,
            "failure_rate_pct": round(gate_failure_rate, 2),
        },
        "login_callback_1h": {
            "ok": login_ok,
            "failed": login_failed,
            "total": login_total,
            "failure_rate_pct": round(login_failure_rate, 2),
        },
        "block_match_1h": block_count,
        "page_requests_1h": ray_count,
        "block_rate_pct": round(block_rate, 2),
        "d1_write_errors_24h": d1_errors,
        "visitors_1h": current_hour,
        "visitors_previous_1h": previous_hour,
        "visitor_drop_pct": round(visitor_drop, 2),
        "status_distribution_1h": data.get("ray_status_distribution_1h", []),
        "alerts": alerts,
    }


def write_health_log(record: dict[str, Any]) -> None:
    try:
        HEALTH_LOG.parent.mkdir(parents=True, exist_ok=True)
        with HEALTH_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except OSError:
        pass


def _load_state() -> dict[str, float]:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(state: dict[str, float]) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(
            json.dumps(state, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def alert_allowed(keys: list[str]) -> bool:
    state = _load_state()
    now = time.time()
    for key in keys:
        if now - state.get(key, 0.0) >= ALERT_COOLDOWN_SECONDS:
            return True
    return False


def mark_alert(keys: list[str]) -> None:
    state = _load_state()
    now = time.time()
    for key in keys:
        state[key] = now
    _save_state(state)


def send_alert(env: dict[str, str], subject: str, body: str) -> bool:
    host = env_value(
        env,
        "SMTP_HOST",
        "ALERT_SMTP_HOST",
        "UPSTREAM_HOST",
        default="smtp.feishu.cn",
    )
    port = int(
        env_value(
            env,
            "SMTP_PORT",
            "ALERT_SMTP_PORT",
            "UPSTREAM_PORT",
            default="465",
        )
        or "465"
    )
    username = env_value(
        env,
        "SMTP_USERNAME",
        "SMTP_USER",
        "ALERT_SMTP_USERNAME",
        "UPSTREAM_USERNAME",
        "NO_REPLY_1_EMAIL",
        "NO_REPLY_EMAIL",
    )
    password = env_value(
        env,
        "SMTP_PASSWORD",
        "SMTP_PASS",
        "ALERT_SMTP_PASSWORD",
        "NO_REPLY_1_PASSWORD",
        "NO_REPLY_PASSWORD",
    )
    from_addr = env_value(
        env,
        "SMTP_FROM",
        "ALERT_FROM",
        "NO_REPLY_1_EMAIL",
        "NO_REPLY_EMAIL",
        default="no-reply-1@limooo.cn",
    )
    to_addr = env_value(
        env,
        "SMTP_TO",
        "ALERT_TO",
        "HEALTH_ALERT_TO",
        default="lime@limooo.cn",
    )
    if not host or not username or not password or not to_addr:
        return False

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = from_addr
    message["To"] = to_addr
    message.set_content(body)
    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            server = smtplib.SMTP(host, port, timeout=15)
            server.starttls()
        with server:
            server.login(username, password)
            server.send_message(message)
    except (OSError, smtplib.SMTPException):
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Limooo 健康检查与告警")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印将执行的检查配置，不访问 D1、不发邮件、不写日志",
    )
    parser.add_argument(
        "--no-email",
        action="store_true",
        help="命中阈值时只记录健康日志，不发送 SMTP 邮件",
    )
    args = parser.parse_args()

    if args.dry_run:
        # dry-run 不读取 secrets 文件，只检查当前 shell 环境是否已显式注入。
        env: dict[str, str] = {}
        cfg = cloudflare_config(env)
        print(json.dumps({
            "mode": "dry-run",
            "queries": list(load_queries()),
            "thresholds": {
                "gate_failure_rate": GATE_FAILURE_RATE_THRESHOLD,
                "gate_unavailable": GATE_UNAVAILABLE_THRESHOLD,
                "login_failure_rate": LOGIN_FAILURE_RATE_THRESHOLD,
                "d1_write_errors": D1_WRITE_ERROR_THRESHOLD,
                "visitor_drop": VISITOR_DROP_THRESHOLD,
            },
            "smtp_configured": bool(
                env_value(env, "SMTP_HOST", "ALERT_SMTP_HOST", "UPSTREAM_HOST")
                and env_value(
                    env,
                    "SMTP_USERNAME",
                    "SMTP_USER",
                    "ALERT_SMTP_USERNAME",
                    "UPSTREAM_USERNAME",
                    "NO_REPLY_1_EMAIL",
                    "NO_REPLY_EMAIL",
                )
                and env_value(
                    env,
                    "SMTP_PASSWORD",
                    "SMTP_PASS",
                    "ALERT_SMTP_PASSWORD",
                    "NO_REPLY_1_PASSWORD",
                    "NO_REPLY_PASSWORD",
                )
            ),
        }, ensure_ascii=False, indent=2))
        return 0
    env = load_env(ENV_FILE, SMTP_ENV_FILE)
    cfg = cloudflare_config(env)

    if not cfg["token"] or not cfg["account_id"] or not cfg["database_id"]:
        record = {"status": "config_error", "message": "Cloudflare/D1 配置缺失"}
        write_health_log(record)
        print(json.dumps(record, ensure_ascii=False))
        return 2

    try:
        ensure_schema(cfg)
        queries = load_queries()
        data = {name: d1_query(cfg, sql) for name, sql in queries.items()}
    except Exception as exc:  # noqa: BLE001
        record = {"status": "query_error", "message": str(exc)}
        write_health_log(record)
        print(json.dumps(record, ensure_ascii=False))
        return 2

    metrics = evaluate_metrics(data)
    alerts = metrics["alerts"]
    record = {
        "status": "alert" if alerts else "ok",
        "ts": int(time.time()),
        "metrics": metrics,
    }
    write_health_log(record)
    print(json.dumps(record, ensure_ascii=False, default=str))

    if not alerts:
        return 0
    if args.no_email:
        return 0
    if not alert_allowed([item["key"] for item in alerts]):
        return 0
    body = "\n".join(f"- {item['message']}" for item in alerts)
    if send_alert(
        env,
        "[Limooo] 健康检查告警",
        f"检测到以下告警：\n\n{body}\n\n详见服务器 {HEALTH_LOG}",
    ):
        mark_alert([item["key"] for item in alerts])
        return 0
    record["status"] = "alert_email_failed"
    write_health_log(record)
    return 3


if __name__ == "__main__":
    sys.exit(main())
