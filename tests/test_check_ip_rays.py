"""ops/check_ip_rays.py 的纯函数测试（IP 归一化 / hash 识别 / 渲染）。"""

import pytest

import ops.check_ip_rays as cir


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("176.122.161.108", "176.122.161.108"),
        (" 176.122.161.108 ", "176.122.161.108"),
        ("[240e:404::1]", "240e:404::1"),
        ("240e:404:9210:1d78:7c62:faff:fef9:34b5", "240e:404:9210:1d78:7c62:faff:fef9:34b5"),
        # 日志里常见 host:port 形式
        ("1.2.3.4:52344", "1.2.3.4"),
    ],
)
def test_normalize_ip_accepts_valid(raw, expected):
    assert cir.normalize_ip(raw) == expected


@pytest.mark.parametrize("raw", ["", "notanip", "999.1.1.1", "1.2.3.4.5"])
def test_normalize_ip_rejects_invalid(raw):
    with pytest.raises(ValueError):
        cir.normalize_ip(raw)


def test_looks_like_hash():
    assert cir.looks_like_hash("d51153cb767fc758")
    assert cir.looks_like_hash("D51153CB767FC758")
    assert not cir.looks_like_hash("d51153cb767fc75")  # 15 位
    assert not cir.looks_like_hash("d51153cb767fc758a")  # 17 位
    assert not cir.looks_like_hash("z1153cb767fc758")  # 非 hex


def test_render_v2_renders_fields():
    line = cir.render_v2(
        {
            "ray": "a4162d53fc471732-SJC",
            "ts": 1790466693,
            "host": "visitor.limooo.cn",
            "path": "/",
            "method": "GET",
            "status": 200,
            "country": "US",
            "duration_ms": 386,
        }
    )
    assert "a4162d53fc471732-SJC" in line
    assert "visitor.limooo.cn" in line
    assert "country=US" in line
    assert line.endswith("386ms")


def test_render_legacy_marks_source():
    line = cir.render_legacy({"ray": "a40468eaedd2a158", "ts": 1790280389, "host": "x", "ip": "1.2.3.4"})
    assert "a40468eaedd2a158" in line
    assert line.endswith("[legacy]")


def test_resolve_hashes_requires_key(monkeypatch):
    """密钥缺失时必须给出警告，而不是静默返回「无记录」。"""
    hashes, warn = cir.resolve_hashes({"token": "t"}, {}, "1.2.3.4")
    assert hashes == []
    assert "VISITOR_IP_KEY" in warn


def test_resolve_hashes_roundtrip(monkeypatch):
    """加密行能被解回 IP，并映射到同一行的 ip_hash。"""
    if cir.Fernet is None:  # pragma: no cover - 取决于解释器
        pytest.skip("cryptography not installed")

    from cryptography.fernet import Fernet

    key = Fernet.generate_key().decode()
    token = Fernet(key.encode()).encrypt(b"176.122.161.108").decode()
    other = Fernet(key.encode()).encrypt(b"8.8.8.8").decode()

    monkeypatch.setattr(
        cir,
        "d1_query_retry",
        lambda cfg, sql, tries=4: [
            {"ip_hash": "d51153cb767fc758", "ip_enc": token},
            {"ip_hash": "aaaaaaaaaaaaaaaa", "ip_enc": other},
            {"ip_hash": "bbbbbbbbbbbbbbbb", "ip_enc": "not-a-valid-token"},
            {"ip_hash": "cccccccccccccccc", "ip_enc": ""},
        ],
    )

    hashes, warn = cir.resolve_hashes({}, {"VISITOR_IP_KEY": key}, "176.122.161.108")
    assert hashes == ["d51153cb767fc758"]
    assert warn is None
