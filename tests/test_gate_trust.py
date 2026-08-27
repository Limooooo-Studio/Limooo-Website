"""docs/14 门禁信任白名单解析测试。"""

from pathlib import Path

import pytest

from ops import check_gate_trust


def test_load_whitelist(tmp_path: Path):
    path = tmp_path / "whitelist.txt"
    path.write_text(
        "# comment\n"
        "ASN/4134\n"
        "ASN/4808\n"
        "IP-CIDR/97.64.18.11/32\n"
        "IP-CIDR/2001:db8::/64\n",
        encoding="utf-8",
    )
    asns, networks = check_gate_trust.load_whitelist(path)
    assert asns == [4134, 4808]
    assert networks == [("97.64.18.11", 32), ("2001:db8::", 64)]


def test_rejects_unknown_line(tmp_path: Path):
    path = tmp_path / "whitelist.txt"
    path.write_text("BOGUS/1\n", encoding="utf-8")
    with pytest.raises(RuntimeError):
        check_gate_trust.load_whitelist(path)
