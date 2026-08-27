"""src/cidr.py 统一 IP/CIDR 规范化测试（docs/10）。"""

import cidr


def test_normalize_ip():
    assert cidr.normalize_ip("1.2.3.4") == "1.2.3.4"
    assert cidr.normalize_ip("2001:0db8:0:0:0:0:0:1") == "2001:db8::1"
    assert cidr.normalize_ip("2001:db8::1") == "2001:db8::1"
    assert cidr.normalize_ip("999.1.1.1") is None
    assert cidr.normalize_ip("2001:::1") is None


def test_parse_and_normalize_cidr():
    assert cidr.parse_cidr("1.2.3") == ("1.2.3.0", 24)
    assert cidr.parse_cidr("1.2.3.4") == ("1.2.3.4", 32)
    assert cidr.parse_cidr("1.2.3.0/24") == ("1.2.3.0", 24)
    assert cidr.parse_cidr("2001:db8::1/64") == ("2001:db8::", 64)
    assert cidr.normalize_cidr("2001:0db8:0:0:0:0:0:1/64") == "2001:db8::/64"
    assert cidr.normalize_cidr("# comment") is None
    assert cidr.normalize_cidr("1.2.3.4/33") is None


def test_network_and_contains():
    assert cidr.network_address("1.2.3.4", 24) == "1.2.3.0"
    assert cidr.network_address("2001:db8::1", 64) == "2001:db8::"
    assert cidr.cidr_contains("2001:db8::/64", "2001:db8::1") is True
    assert cidr.cidr_contains("2001:db8::/64", "2001:db9::1") is False
    assert cidr.cidr_contains("1.2.3.0/24", "1.2.3.9") is True
    assert cidr.cidr_contains("bad", "1.2.3.4") is False
