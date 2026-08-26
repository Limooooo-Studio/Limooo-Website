"""构建脚本纯函数测试（不写 public/ 产物）。"""

import build
import app


def test_preview_i18n_patch_contains_all_languages():
    patch = build.preview_i18n_patch()
    assert "zh-cn" in patch
    assert "en-us" in patch
    assert "ja-jp" in patch
    assert "ko-kr" in patch
    assert "window.__PREVIEW_I18N__" in patch


def test_render_page_switches_language():
    html = build.render_page(app, "index.html", "/", "zh-cn")
    assert '<html lang="zh-cn">' in html
    assert "/static/" in html
    html_en = build.render_page(app, "index.html", "/", "en-us")
    assert '<html lang="en-us">' in html_en
