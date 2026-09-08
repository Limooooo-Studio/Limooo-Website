#!/usr/bin/env python3
# status.limooo.cn/claude - status.claude.com(Instatus) webhook 接收 + 事件展示界面
# POST ?token=... : 接收 webhook 并写入 SQLite，返回 200（nginx 已校验 token）
# GET            : 展示事件时间线/当前状态（nginx 走 __gate 人机验证）
import os, hmac, hashlib, json, time, sqlite3, html
from urllib.request import Request, urlopen
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

DB = os.environ.get("STATUS_DB", "/opt/claude-webhook/events.db")
LOG = os.environ.get("STATUS_LOG", "/var/log/claude-webhook/claude.log")
SUMMARY_CACHE = os.environ.get("STATUS_SUMMARY_CACHE", "/opt/claude-webhook/summary.json")
LOG_MAX = 5 * 1024 * 1024
LISTEN = ("127.0.0.1", int(os.environ.get("STATUS_PORT", "3003")))
SECRET = os.environ.get("INSTATUS_WEBHOOK_SECRET", "") or os.environ.get("CLAUDE_WEBHOOK_SECRET", "") or ""
PROVIDER = os.environ.get("STATUS_PROVIDER", "Claude")
SOURCE = os.environ.get("STATUS_SOURCE", "status.claude.com")
MAX_BODY = 1024 * 1024
_IO = None

def _log(entry: str):
    global _IO
    try:
        if _IO is None:
            os.makedirs(os.path.dirname(LOG), exist_ok=True)
            _IO = open(LOG, "a", encoding="utf-8")
        _IO.write(entry); _IO.flush()
        if os.path.getsize(LOG) > LOG_MAX:
            _IO.close(); os.replace(LOG, LOG + ".1"); _IO = open(LOG, "a", encoding="utf-8")
    except Exception:
        pass

def _db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT,
        incident_id TEXT, incident_name TEXT, incident_status TEXT,
        maintenance_id TEXT, maintenance_name TEXT, maintenance_status TEXT,
        component_id TEXT, component_name TEXT, component_status TEXT, new_status TEXT,
        impact TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT,
        raw TEXT, received_at TEXT)""")
    return conn

def record(payload):
    meta = payload.get("meta", {}) if isinstance(payload, dict) else {}
    page = payload.get("page", {}) if isinstance(payload, dict) else {}
    incident = payload.get("incident", {}) if isinstance(payload, dict) else {}
    maintenance = payload.get("maintenance", {}) if isinstance(payload, dict) else {}
    cupd = payload.get("component_update", {}) if isinstance(payload, dict) else {}
    comp = payload.get("component", {}) if isinstance(payload, dict) else {}
    recv = datetime.now(timezone.utc).isoformat()
    raw = json.dumps(payload, ensure_ascii=False)
    conn = _db()
    try:
        # Cloudflare Notifications 的标准 webhook：用 correlation id 合并一条告警的
        # 开始/结束事件，以 alert_event 映射为本页面现有的 incident 状态。
        if payload.get("alert_type") or payload.get("alert_correlation_id"):
            alert_event = (payload.get("alert_event") or "").upper()
            alert_status = "RESOLVED" if alert_event.endswith("_END") else "INVESTIGATING"
            created = payload.get("ts")
            if isinstance(created, (int, float)):
                created = datetime.fromtimestamp(created, timezone.utc).isoformat()
            conn.execute("""INSERT INTO events (event_type, incident_id, incident_name, incident_status, impact,
                created_at, updated_at, resolved_at, raw, received_at)
                VALUES ('incident', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (payload.get("alert_correlation_id") or payload.get("policy_id"),
                 payload.get("name") or payload.get("alert_type") or "Cloudflare 通知",
                 alert_status, payload.get("text") or payload.get("alert_type"), created, created,
                 created if alert_status == "RESOLVED" else None, raw, recv))
        elif incident:
            conn.execute("""INSERT INTO events (event_type, incident_id, incident_name, incident_status, impact,
                created_at, updated_at, resolved_at, raw, received_at)
                VALUES ('incident', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (incident.get("id"), incident.get("name"), incident.get("status"), incident.get("impact"),
                 incident.get("created_at"), incident.get("updated_at"), incident.get("resolved_at"), raw, recv))
        elif maintenance:
            conn.execute("""INSERT INTO events (event_type, maintenance_id, maintenance_name, maintenance_status, impact,
                created_at, updated_at, resolved_at, raw, received_at)
                VALUES ('maintenance', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (maintenance.get("id"), maintenance.get("name"), maintenance.get("status"), maintenance.get("impact"),
                 maintenance.get("created_at"), maintenance.get("updated_at"), maintenance.get("resolved_at"), raw, recv))
        elif cupd:
            conn.execute("""INSERT INTO events (event_type, component_id, component_name, component_status, new_status,
                created_at, raw, received_at) VALUES ('component', ?, ?, ?, ?, ?, ?, ?)""",
                (cupd.get("component_id"), comp.get("name"), comp.get("status"), cupd.get("new_status"),
                 cupd.get("created_at"), raw, recv))
        else:
            conn.execute("INSERT INTO events (event_type, raw, received_at) VALUES ('unknown', ?, ?)", (raw, recv))
        conn.commit()
        return True
    finally:
        conn.close()

STATUS_TXT = {
    "INVESTIGATING": "调查中", "IDENTIFIED": "已定位", "MONITORING": "监控中", "RESOLVED": "已解决",
    "OPERATIONAL": "正常", "UNDERMAINTENANCE": "维护中", "DEGRADEDPERFORMANCE": "性能下降",
    "PARTIALOUTAGE": "部分故障", "MAJOROUTAGE": "重大故障",
    "NOTSTARTEDYET": "未开始", "INPROGRESS": "进行中", "COMPLETED": "已完成",
}
def txt(s):
    return STATUS_TXT.get((s or "").upper(), s or "-")

def badge(s):
    key = (s or "").upper()
    tone = {
        "INVESTIGATING": "warning", "IDENTIFIED": "warning", "MONITORING": "info", "RESOLVED": "success",
        "OPERATIONAL": "success", "UNDERMAINTENANCE": "info", "DEGRADEDPERFORMANCE": "warning",
        "PARTIALOUTAGE": "danger", "MAJOROUTAGE": "danger", "INPROGRESS": "info", "COMPLETED": "success",
        "NOTSTARTEDYET": "neutral",
    }.get(key, "neutral")
    return '<span class="status-badge status-badge--%s">%s</span>' % (tone, html.escape(txt(s)))

def recent_incidents(conn, n=30):
    try:
        cur = conn.execute("""SELECT e.* FROM events e
            JOIN (SELECT incident_id, MAX(id) AS mid FROM events WHERE event_type='incident' AND incident_id IS NOT NULL GROUP BY incident_id) t
            ON e.id=t.mid ORDER BY e.id DESC LIMIT ?""", (n,))
    except Exception:
        return []
    return [dict(r) for r in cur.fetchall()]

def recent_components(conn, n=50):
    try:
        cur = conn.execute("""SELECT e.* FROM events e
            JOIN (SELECT component_id, MAX(id) AS mid FROM events WHERE event_type='component' AND component_id IS NOT NULL GROUP BY component_id) t
            ON e.id=t.mid ORDER BY e.id DESC LIMIT ?""", (n,))
    except Exception:
        return []
    return [dict(r) for r in cur.fetchall()]

def recent_events(conn, n=30):
    try:
        # Unrecognized historic payloads remain in SQLite for audit but do not
        # belong in the public status timeline.
        cur = conn.execute("SELECT * FROM events WHERE event_type != 'unknown' ORDER BY id DESC LIMIT ?", (n,))
    except Exception:
        return []
    return [dict(r) for r in cur.fetchall()]

def upstream_summary():
    """Read Claude's public Instatus summary on every page load.

    Webhooks are event-driven and can remain silent for days; they are retained as
    the audit timeline but must not be the sole source for the current state.
    """
    if PROVIDER != "Claude":
        return None
    try:
        if os.path.exists(SUMMARY_CACHE) and time.time() - os.path.getmtime(SUMMARY_CACHE) < 125:
            with open(SUMMARY_CACHE, "r", encoding="utf-8") as cached:
                data = json.load(cached)
            if isinstance(data, dict):
                return data
        req = Request("https://status.claude.com/api/v2/summary.json", headers={"User-Agent": "Limooo-Status/1.0"})
        with urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
        return data if isinstance(data, dict) else None
    except Exception as ex:
        _log("[%s] Claude summary unavailable: %s\\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), ex))
        return None

def render():
    conn = _db()
    try:
        incs = recent_incidents(conn)
        comps = recent_components(conn)
        evs = recent_events(conn)
        summary = upstream_summary()
        if summary:
            live_components = summary.get("components") or []
            live_incidents = summary.get("incidents") or []
            comps = [{"component_name": c.get("name"), "component_status": c.get("status"), "updated_at": c.get("updated_at"), "received_at": c.get("updated_at")} for c in live_components if isinstance(c, dict)]
            incs = [{"incident_name": i.get("name"), "incident_status": i.get("status"), "impact": i.get("impact"), "updated_at": i.get("updated_at"), "received_at": i.get("created_at")} for i in live_incidents if isinstance(i, dict)]
        active = [i for i in incs if (i.get("incident_status") or "").upper() not in ("RESOLVED", "COMPLETED")]
        overall = "HASISSUES" if active else "OPERATIONAL"
    finally:
        conn.close()
    title = "%s 服务状态 · LIMOOO" % PROVIDER
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    def when(value):
        return html.escape((value or "").replace("T", " ").replace("+00:00", " UTC")[:25] or "—")
    parts = ["""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>%s</title>
<script src="/static/js/theme-preload.js?v=2"></script>
<link rel="icon" href="https://images.limooo.cn/static/icons/favicon.ico" sizes="any">
<link rel="preload" href="/static/fonts/baloo2/baloo2-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/tailwind.css?v=4"><link rel="stylesheet" href="/static/fonts-round75.css?v=2">
<link rel="stylesheet" href="/static/css/base.css?v=16"><link rel="stylesheet" href="/static/css/claude-status.css?v=1">
</head><body class="antialiased" data-lang="zh-cn" data-i18n-dict="{}">
<nav class="site-nav fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl z-[100] flex items-center px-5 md:px-8 h-[70px] md:h-[100px] claude-nav" aria-label="主导航">
  <a href="https://limooo.cn" class="flex items-center gap-2 md:gap-2.5 shrink-0"><span class="nav-brand text-lg md:text-2xl font-semibold uppercase tracking-[0.05em]">LIMOOO</span></a>
  <div class="flex items-center ml-auto"><div class="global-nav hidden md:flex items-center"><a href="https://limooo.cn"><span data-i18n="nav_home">主页</span><svg class="nav-external" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5H9z"/></svg></a><a href="https://services.limooo.cn"><span data-i18n="nav_services">服务</span><svg class="nav-external" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5H9z"/></svg></a><a href="https://contact.limooo.cn"><span data-i18n="nav_contact">联系</span><svg class="nav-external" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5H9z"/></svg></a></div><span class="nav-divider hidden md:block"></span><div class="theme-toggle lang-flyout"><button class="lang-btn" data-action="toggleLangMenu" data-needs-event aria-label="切换语言" aria-haspopup="true"><svg class="lang-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg><svg class="lang-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button><div id="langMenu" class="theme-menu"><div class="theme-option selected" data-lang="zh-cn" data-action="setLang" data-arg="zh-cn"><span class="lang-flag">🇨🇳</span><span data-i18n="lang_zh">中文</span></div><div class="theme-option" data-lang="en-us" data-action="setLang" data-arg="en-us"><span class="lang-flag">🇺🇸</span><span data-i18n="lang_en">English</span></div><div class="theme-option" data-lang="ja-jp" data-action="setLang" data-arg="ja-jp"><span class="lang-flag">🇯🇵</span><span data-i18n="lang_ja">日本語</span></div><div class="theme-option" data-lang="ko-kr" data-action="setLang" data-arg="ko-kr"><span class="lang-flag">🇰🇷</span><span data-i18n="lang_ko">한국어</span></div></div></div><span class="nav-divider hidden md:block"></span><button class="appearance-switch" type="button" role="switch" aria-checked="false" data-action="toggleTheme" aria-label="切换主题"><span class="appearance-check"><span class="appearance-icon"><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></span></span></button></div>
</nav><main class="claude-main"><header class="claude-hero"><h1>%s 服务状态</h1></header>""" % (html.escape(title), html.escape(PROVIDER))]
    overall_label = "所有已知服务正常" if overall == "OPERATIONAL" else "检测到正在处理的事件"
    source_time = ((summary or {}).get("page") or {}).get("updated_at") or now
    source_label = "官方状态源" if summary else "最近接收到的 webhook"
    parts.append("<section class='overall-card overall-card--%s' aria-label='整体状态'><span class='overall-indicator' aria-hidden='true'></span><div><strong>%s</strong><p>依据%s · 更新于 %s</p></div></section>" % ("healthy" if overall == "OPERATIONAL" else "attention", overall_label, source_label, when(source_time)))
    parts.append("<section class='claude-section'><div class='section-heading'><div><p class='section-kicker'>COMPONENTS</p><h2>当前组件</h2></div><span class='section-count'>%d 项</span></div><div class='status-card'>" % len(comps))
    if comps:
        parts.append("<ul class='event-list'>")
        for c in comps:
            st = (c.get("component_status") or "").upper()
            parts.append("<li class='event-row'><div class='event-copy'><strong>%s</strong><span>最近更新：%s</span></div><div class='event-meta'>%s<time>%s</time></div></li>"
                % (html.escape(c.get("component_name") or c.get("component_id") or "-"),
                   when(c.get("updated_at") or c.get("created_at")),
                   badge(st if st else (c.get("new_status") or "")),
                   when(c.get("received_at"))))
        parts.append("</ul>")
    else:
        parts.append("<div class='empty-state'>尚未收到组件状态事件。</div>")
    parts.append("</div></section>")
    parts.append("<div class='claude-details'><section class='claude-section'><div class='section-heading'><div><p class='section-kicker'>INCIDENTS</p><h2>事件</h2></div><span class='section-count'>%d 项</span></div><div class='status-card'>" % len(incs))
    if incs:
        parts.append("<ul class='event-list'>")
        for i in incs:
            st = (i.get("incident_status") or "").upper()
            parts.append("<li class='event-row'><div class='event-copy'><strong>%s</strong><span>影响范围：%s</span></div><div class='event-meta'>%s<time>%s</time></div></li>"
                % (html.escape(i.get("incident_name") or i.get("incident_id") or "-"),
                   html.escape((i.get("impact") or "-")),
                   badge(st), when(i.get("updated_at") or i.get("received_at"))))
        parts.append("</ul>")
    else:
        parts.append("<div class='empty-state'>暂无 incident 事件。</div>")
    parts.append("</div></section>")
    parts.append("<section class='claude-section'><div class='section-heading'><div><p class='section-kicker'>ACTIVITY</p><h2>最近活动</h2></div><span class='section-count'>%d 条</span></div><div class='status-card'>" % len(evs))
    if evs:
        parts.append("<ul class='event-list'>")
        for e in evs:
            kind = e.get("event_type") or "-"
            name = e.get("incident_name") or e.get("maintenance_name") or e.get("component_name") or kind
            st = e.get("incident_status") or e.get("maintenance_status") or e.get("new_status") or e.get("component_status") or "-"
            parts.append("<li class='event-row'><div class='event-copy'><strong>%s</strong><span>%s · %s</span></div><div class='event-meta'>%s<time>%s</time></div></li>"
                % (html.escape(name), html.escape(kind.upper()), html.escape(txt((e.get("incident_id") or e.get("maintenance_id") or e.get("component_id") or "-"))), badge(st), when(e.get("received_at"))))
        parts.append("</ul>")
    else:
        parts.append("<div class='empty-state'>等待新的 webhook 事件…</div>")
    parts.append("</div></section></div><p class='status-source'>数据由 %s 事件 webhook 提供</p></main><footer class='global-footer' id='global-footer'><div class='footer-link'><div class='footer-text'><span class='footer-copyright'>&copy; 2026 <span class='footer-brand'>LIMOOO</span> Studio</span><span> | 保留所有权利</span><span> | 根据 AGPL-3.0 许可证发布，源码在</span><a class='footer-source-link' href='https://github.com/Limooooo-Studio/Limooo-Website' target='_blank' rel='noopener noreferrer'>这里</a></div></div></footer><script src='/static/js/claude-status.js?v=1' defer></script><script src='/static/js/actions.js?v=1' defer></script><script src='/static/js/base.js?v=9' defer></script></body></html>" % html.escape(SOURCE))
    return "".join(parts).encode("utf-8")

def _sig(secret, data):
    return hmac.new(secret.encode("utf-8"), data, hashlib.sha256).hexdigest()

def verify_signature(headers, body):
    if not SECRET:
        return None
    provided = (headers.get("x-instatus-webhook-signature", "") or "").strip()
    if not provided:
        return None
    cands = [body]
    try:
        canon = json.dumps(json.loads(body.decode("utf-8")), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if canon != body:
            cands.append(canon)
    except Exception:
        pass
    for data in cands:
        if hmac.compare_digest(_sig(SECRET, data), provided):
            return True
    return False

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError:
            _log("[%s] POST %s -> 400 invalid_content_length\n" % (ts, self.path))
            self._send(400, b'{"ok":false,"error":"invalid_content_length"}')
            return
        if length < 0 or length > MAX_BODY:
            _log("[%s] POST %s -> 413\n" % (ts, self.path)); self._send(413, b'{"ok":false,"error":"too_large"}'); return
        body = self.rfile.read(length) if length else b""
        sig = verify_signature(self.headers, body)
        if sig is False:
            _log("[%s] POST %s -> 401 invalid_signature\n" % (ts, self.path)); self._send(401, b'{"ok":false,"error":"invalid_signature"}'); return
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            _log("[%s] POST %s -> 400 invalid_json\n" % (ts, self.path))
            self._send(400, b'{"ok":false,"error":"invalid_json"}')
            return
        if not isinstance(payload, dict):
            _log("[%s] POST %s -> 400 invalid_payload\n" % (ts, self.path))
            self._send(400, b'{"ok":false,"error":"invalid_payload"}')
            return
        try:
            ok = record(payload)
        except Exception as ex:
            _log("[%s] POST %s -> 500 db_err=%s\n" % (ts, self.path, ex)); self._send(500, b'{"ok":false,"error":"db"}'); return
        _log("[%s] POST %s -> 200 recorded=%s body=%s\n" % (ts, self.path, ok, body[:1200]))
        self._send(200, b'{"ok":true}')
    def do_GET(self):
        body = render()
        self._send(200, body, "text/html; charset=utf-8")
    def do_PUT(self): self._send(405, b'{"ok":false,"error":"method"}')
    def log_message(self, *a): pass

def main():
    _db().close()
    ThreadingHTTPServer(LISTEN, Handler).serve_forever()

if __name__ == "__main__":
    main()
