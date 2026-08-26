"""Apple ID 邮箱规范化和密码脱敏测试。"""

import app


def test_normalize_appleid_email():
    assert app._normalize_appleid_email("alice@foo") == "alice@appleid.limooo.cn"
    assert app._normalize_appleid_email("  bob  ") == "bob@appleid.limooo.cn"


def test_mask_password():
    assert app._mask_password("secret") == "······"
    assert app._mask_password("") == ""
