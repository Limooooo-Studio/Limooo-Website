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
