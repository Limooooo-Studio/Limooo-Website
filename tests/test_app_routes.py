"""几个不依赖登录/外部服务的路由冒烟测试。"""

import app


def test_api_i18n_returns_locale():
    client = app.app.test_client()
    resp = client.get("/api/i18n/en-us")
    assert resp.status_code == 200
    assert resp.get_json()["redirect_title"] == "Redirecting"


def test_api_i18n_rejects_unknown_language():
    client = app.app.test_client()
    assert client.get("/api/i18n/fr-fr").status_code == 404


def test_auth_status_not_authenticated():
    client = app.app.test_client()
    assert client.get("/api/auth/status").get_json()["authed"] is False
