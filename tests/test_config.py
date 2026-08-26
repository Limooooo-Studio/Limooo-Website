"""config 工具函数与 geo_cache 建表测试。"""

import sqlite3

from config import ensure_geo_cache, get_cached_geo, is_private_ip


def test_ip_ranges():
    assert is_private_ip("127.0.0.1") is True
    assert is_private_ip("192.168.1.1") is True
    assert is_private_ip("10.0.0.1") is True
    assert is_private_ip("8.8.8.8") is False


def test_ensure_geo_cache_and_read(tmp_path):
    conn = sqlite3.connect(tmp_path / "geo.db")
    ensure_geo_cache(conn)
    conn.execute(
        "INSERT INTO geo_cache (ip, country, city, latitude, longitude, isp, asn) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("8.8.8.8", "US", "Mountain View", 37.4, -122.0, "Google", "AS15169"),
    )
    conn.commit()
    row = get_cached_geo(conn, "8.8.8.8")
    assert row and row["country"] == "US" and row["asn"] == "AS15169"
    conn.close()
