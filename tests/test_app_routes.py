"""最小 Flask 运行时的冒烟测试：只验证 VPS 保留路由。"""

import app


def test_backchannel_logout_rejects_missing_token():
    client = app.app.test_client()
    resp = client.post("/logout/backchannel", data={})
    assert resp.status_code == 400


def test_gate_check_rejects_invalid_cookie():
    client = app.app.test_client()
    resp = client.get("/__gate_check", headers={"Cookie": "__gate=invalid"})
    assert resp.status_code == 403


def test_gate_check_rejects_missing_key():
    client = app.app.test_client()
    resp = client.get("/__gate_check")
    assert resp.status_code == 403


def test_gate_check_allows_shared_whitelist_ip(monkeypatch, tmp_path):
    whitelist = tmp_path / "whitelist.txt"
    whitelist.write_text("IP-CIDR/203.0.113.7/32\n", encoding="utf-8")
    monkeypatch.setattr(app, "GATE_WHITELIST_FILE", str(whitelist))
    monkeypatch.setattr(app, "_gate_whitelist_cache", None)

    client = app.app.test_client()
    resp = client.get("/__gate_check", headers={"CF-Connecting-IP": "203.0.113.7"})
    assert resp.status_code == 204


def test_gate_check_allows_shared_whitelist_asn(monkeypatch, tmp_path):
    whitelist = tmp_path / "whitelist.txt"
    whitelist.write_text("ASN/64512\n", encoding="utf-8")
    monkeypatch.setattr(app, "GATE_WHITELIST_FILE", str(whitelist))
    monkeypatch.setattr(app, "_gate_whitelist_cache", None)

    client = app.app.test_client()
    resp = client.get("/__gate_check", headers={"CF-ASN": "64512"})
    assert resp.status_code == 204


def test_kuma_auth_check_rejects_before_calling_authentik(monkeypatch):
    monkeypatch.setattr(app, "_gate_allowed", lambda: False)
    called = False

    def unexpected_request(*_args, **_kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(app.requests, "get", unexpected_request)
    resp = app.app.test_client().get("/__kuma_auth_check")

    assert resp.status_code == 403
    assert not called


def test_provider_status_reuses_a_successful_summary(monkeypatch):
    class SummaryResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"components": [], "incidents": [], "page": {"updated_at": "now"}}

    calls = []
    monkeypatch.setattr(app, "_provider_events", lambda _provider: [])
    monkeypatch.setattr(app.requests, "get", lambda *args, **kwargs: calls.append((args, kwargs)) or SummaryResponse())
    monkeypatch.setattr(app, "_provider_summary_cache", {})
    monkeypatch.setitem(app.STATUS_PROVIDER_SUMMARIES, "claude", ("/not-a-snapshot.json", "https://example.test"))

    client = app.app.test_client()
    assert client.get("/claude").status_code == 200
    assert client.get("/claude").status_code == 200
    assert len(calls) == 1
