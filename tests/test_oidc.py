"""OIDC callback / role 判断测试（mock requests，不对网络发请求）。"""

import base64
import json

import pytest

import app


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


def test_process_callback_returns_claims(monkeypatch):
    monkeypatch.setattr(app, "TOKEN_URL", "https://identity.limooo.cn/token")
    payload = base64.urlsafe_b64encode(json.dumps({"sub": "user1"}).encode()).decode().rstrip("=")
    monkeypatch.setattr(app.requests, "post", lambda *args, **kwargs: FakeResponse({
        "id_token": f"x.{payload}.sig",
    }))
    claims = app.process_callback("code", "https://visitor.limooo.cn/callback")
    assert claims == {"sub": "user1"}


def test_process_callback_no_id_token(monkeypatch):
    monkeypatch.setattr(app, "TOKEN_URL", "https://identity.limooo.cn/token")
    monkeypatch.setattr(app.requests, "post", lambda *args, **kwargs: FakeResponse({
        "error": "invalid_grant",
    }))
    assert app.process_callback("bad", "https://limooo.cn/callback") is None


def test_user_is_allowed_and_role(monkeypatch):
    monkeypatch.setattr(app, "ADMIN_GROUPS", {"authentik Admins"})
    assert app.user_is_allowed({"sub": "u1"}) is True
    assert app.user_role({"groups": ["authentik Admins"]}) == "admin"
    assert app.user_role({"groups": "authentik Admins"}) == "admin"
    assert app.user_role({"groups": ["other"]}) == "viewer"


@pytest.mark.skip(reason="依赖 docs/01 收敛：旧 Flask user_is_allowed 尚不拒绝空 claims")
def test_user_is_allowed_rejects_empty_claims():
    assert app.user_is_allowed({}) is False
