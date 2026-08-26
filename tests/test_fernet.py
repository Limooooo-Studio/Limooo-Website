"""Apple ID 密码 Fernet 加解密测试（测试专用 key）。"""

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

import app


TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
TOKEN_FIXTURE = Path(__file__).parent / "fixtures" / "fernet_token.txt"


def test_fixed_ticket_round_trip():
    key = TEST_KEY
    fernet = Fernet(key.encode())
    token = fernet.encrypt(b"hello-limooo").decode()
    assert fernet.decrypt(token.encode()) == b"hello-limooo"


def test_wrong_key_rejected():
    token = Fernet(TEST_KEY.encode()).encrypt(b"secret").decode()
    with pytest.raises(Exception):
        Fernet("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWZ9".encode()).decrypt(token.encode())


def test_fixture_is_python_decryptable():
    token = TOKEN_FIXTURE.read_text(encoding="utf-8").strip()
    assert Fernet(TEST_KEY.encode()).decrypt(token.encode()) == b"hello-limooo"


def test_app_cipher_uses_env_key(monkeypatch):
    monkeypatch.setenv("APPLEID_ENCRYPTION_KEY", TEST_KEY)
    cipher = app._get_appleid_cipher()
    token = cipher.encrypt(b"abc").decode()
    assert cipher.decrypt(token.encode()) == b"abc"
