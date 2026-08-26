"""门禁 cookie 签名/校验测试。"""

import time

import app


KEY = "test-gate-key"


def test_valid_cookie():
    expiry = int(time.time()) + 60
    payload = str(expiry)
    sig = app._gate_hmac_hex(KEY, payload)
    assert app._gate_cookie_valid(f"{payload}.{sig}", KEY) is True


def test_expired_cookie():
    payload = str(int(time.time()) - 60)
    sig = app._gate_hmac_hex(KEY, payload)
    assert app._gate_cookie_valid(f"{payload}.{sig}", KEY) is False


def test_tampered_cookie():
    payload = str(int(time.time()) + 60)
    sig = app._gate_hmac_hex(KEY, payload)
    assert app._gate_cookie_valid(f"{payload}.{'0' * 64}", KEY) is False


def test_wrong_key_and_malformed_cookie():
    payload = str(int(time.time()) + 60)
    sig = app._gate_hmac_hex("another-key", payload)
    assert app._gate_cookie_valid(f"{payload}.{sig}", KEY) is False
    assert app._gate_cookie_valid("not-a-cookie", KEY) is False
