"""Regression tests for malformed status webhook requests."""

from __future__ import annotations

import importlib.util
import io
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "ops" / "claude-webhook" / "app.py"
SPEC = importlib.util.spec_from_file_location("status_webhook", MODULE_PATH)
assert SPEC and SPEC.loader
status_webhook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(status_webhook)


def _post(content_length: str, body: bytes = b"") -> tuple[int, bytes]:
    handler = status_webhook.Handler.__new__(status_webhook.Handler)
    handler.headers = {"Content-Length": content_length}
    handler.path = "/claude"
    handler.rfile = io.BytesIO(body)
    result: dict[str, object] = {}
    handler._send = lambda code, response, ctype="application/json": result.update(
        code=code,
        response=response,
        ctype=ctype,
    )
    handler.do_POST()
    return result["code"], result["response"]  # type: ignore[return-value]


def test_status_webhook_rejects_invalid_content_length(monkeypatch):
    monkeypatch.setattr(status_webhook, "_log", lambda _entry: None)
    assert _post("not-a-number") == (400, b'{"ok":false,"error":"invalid_content_length"}')
    assert _post("-1") == (413, b'{"ok":false,"error":"too_large"}')


def test_status_webhook_rejects_invalid_json_payload(monkeypatch):
    monkeypatch.setattr(status_webhook, "_log", lambda _entry: None)
    assert _post("1", b"{") == (400, b'{"ok":false,"error":"invalid_json"}')
    assert _post("2", b"[]") == (400, b'{"ok":false,"error":"invalid_payload"}')
