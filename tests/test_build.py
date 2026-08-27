"""构建脚本纯函数测试（不写 public/ 产物）。"""

from pathlib import Path

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


def test_body_translation_dict_does_not_collide_with_i18n_markers():
    html = build.render_page(app, "index.html", "/", "zh-cn")
    body_start = html.index("<body")
    body_open = html[body_start:html.index(">", body_start) + 1]

    assert "data-i18n-dict='" in body_open
    assert "data-i18n='" not in body_open

    base_js = Path(build.BASE_DIR) / "src/static/js/base.js"
    assert "getAttribute('data-i18n-dict')" in base_js.read_text(encoding="utf-8")


def test_theme_challenge_uses_gate_url_and_skips_gate_page():
    html = build.render_page(app, "index.html", "/", "zh-cn")
    assert 'data-gate-url="https://auth.limooo.cn/__gate"' in html
    gate_html = build.render_gate(app, "zh-cn")
    assert 'data-gate-url=' not in gate_html


def test_visitor_inherits_base_nav_logo():
    html = build.render_page(app, "visitor.html", "/visitor", "zh-cn")
    logo_start = html.index('id="nav-logo"')
    logo_open_end = html.index(">", logo_start) + 1

    assert "LIMOOO" in html[logo_start:html.index("</a>", logo_open_end)]
    assert 'href="https://limooo.cn"' in html[html.rindex("<a", 0, logo_start):logo_open_end]


def test_static_ignore_skips_parallel_artifacts():
    ignored = build._static_ignore("/tmp/static", [
        "visitor.js",
        "visitor 2.js",
        "visitors 3.ts",
        ".DS_Store",
        "legacy.bak",
        "normal.css",
    ])
    assert ignored == {
        "visitor 2.js",
        "visitors 3.ts",
        ".DS_Store",
        "legacy.bak",
        "__pycache__",
    }


def test_remove_bad_artifacts(tmp_path):
    root = tmp_path / "static"
    root.mkdir()
    (root / ".DS_Store").write_bytes(b"")
    (root / "visitor 2.js").write_text("old", encoding="utf-8")
    (root / "visitor.js").write_text("new", encoding="utf-8")

    build._remove_bad_artifacts(str(root))

    assert not (root / ".DS_Store").exists()
    assert not (root / "visitor 2.js").exists()
    assert (root / "visitor.js").read_text(encoding="utf-8") == "new"
