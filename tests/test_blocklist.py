"""封禁名单解析与扫描特征测试。"""

import auto_block


def test_scan_path_patterns():
    assert auto_block._is_scan_path("/.env") is True
    assert auto_block._is_scan_path("/.git/config") is True
    assert auto_block._is_scan_path("/wp-admin") is True
    assert auto_block._is_scan_path("/") is False
    assert auto_block._is_scan_path("/services") is False


def test_normalize_cidr():
    assert auto_block._normalize_cidr("1.2.3") == "1.2.3.0/24"
    assert auto_block._normalize_cidr("1.2.3.0/24") == "1.2.3.0/24"
    assert auto_block._normalize_cidr("1.2.3.4") == "1.2.3.4"
    assert auto_block._normalize_cidr("# comment") is None


def test_read_blocklist_txt(tmp_path):
    p = tmp_path / "blocklist.txt"
    p.write_text(
        "# header\n\n"
        "1.2.3.0/24\n"
        "4.5.6.7/32\n",
        encoding="utf-8",
    )
    static, prefixes = auto_block.read_blocklist_txt(str(p))
    assert static == ["# header", "", "4.5.6.7/32"]
    assert prefixes == {"1.2.3"}
