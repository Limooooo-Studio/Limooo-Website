"""开放重定向相关的安全函数测试。"""

import app


def test_safe_next_rejects_empty_and_non_https():
    assert app._safe_next(None) == "https://limooo.cn/"
    assert app._safe_next("http://evil.example/") == "https://limooo.cn/"
    assert app._safe_next("javascript:alert(1)") == "https://limooo.cn/"


def test_safe_next_allows_external_https():
    assert app._safe_next("https://example.com/path") == "https://example.com/path"
    assert app._safe_next("https://limooo.cn/portfolio") == "https://limooo.cn/portfolio"


def test_is_limooo_target():
    assert app._is_limooo_target("https://limooo.cn/") is True
    assert app._is_limooo_target("https://www.limooo.cn/a") is True
    assert app._is_limooo_target("https://limooo.cn.evil.com/") is False
    assert app._is_limooo_target("https://evil.com/") is False
