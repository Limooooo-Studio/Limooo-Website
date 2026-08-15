#!/usr/bin/env python3
"""Limooo → Cloudflare Pages 静态化构建脚本

把 Jinja 模板按 4 种语言预渲染成 public/ 下的静态 HTML，并生成：
  - public/<lang>/index.html / services.html / contact.html（中间件按语言吐到干净 URL）
  - public/static/ 静态资源镜像
  - functions/api/i18n/[lang].ts + functions/_data/i18n.ts（前端语言切换用）

运行：python3 build.py
输出目录：public/（git 只保留 .gitkeep，部署用 wrangler pages deploy 直传）
"""

import json
import os
import re
import shutil
import sys

# 仓库根目录（本文件位于 src/ 下，向上取一层）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
STATIC_DIR = os.path.join(BASE_DIR, "static")
LOCALES_DIR = os.path.join(BASE_DIR, "locales")
FUNCTIONS_DIR = os.path.join(BASE_DIR, "functions")

LANGS = ("zh-CN", "en-US", "ja-JP", "ko-KR")
DEFAULT_LANG = "en-US"

# (模板, 输出文件名, 渲染路径) —— 用 Host: limooo.cn 渲染（is_prod=True），
# 导航链接保留子域绝对地址（limooo.cn / services.limooo.cn / contact.limooo.cn），
# 由中间件按主机名把对应语言页面吐到干净 URL，不做语言路径前缀。
PAGES = (
    ("index.html", "index.html", "/"),
    ("services.html", "services.html", "/services"),
    ("contact.html", "contact.html", "/contact"),
)


def render_page(appmod, template: str, path: str, lang: str) -> str:
    """用 Flask 渲染上下文渲染单个页面（Host 固定为 limooo.cn）"""
    with appmod.app.test_request_context(path, headers={"Host": "limooo.cn"}):
        appmod.g.lang = lang
        html = appmod.render_template(template)
    # 相对资源统一加根斜杠：模板里是 src="static/..."，在 /zh-CN 这类子路径下
    # 会解析错位，改成 /static/... 后任何路径都正确（配合中间件干净 URL）
    html = html.replace('src="static/', 'src="/static/')
    html = html.replace('href="static/', 'href="/static/')
    # 记住当前语言，保证根路径重定向时语言不跳变
    cookie_js = (
        "<script>try{document.cookie='user_lang_preference=" + lang +
        ";path=/;max-age=31536000;SameSite=Lax'+(location.protocol==='https:'?';Secure':'')}"
        "catch(e){}</script>"
    )
    html = html.replace("</body>", cookie_js + "</body>")
    return html


def write_i18n_functions() -> None:
    """把 locales/*.json 内联进 functions/_data/i18n.ts，并生成 /api/i18n/<lang>"""
    data: dict[str, dict[str, str]] = {}
    for lang in LANGS:
        with open(os.path.join(LOCALES_DIR, f"{lang}.json"), encoding="utf-8") as f:
            data[lang] = json.load(f)

    ts_path = os.path.join(FUNCTIONS_DIR, "_data", "i18n.ts")
    os.makedirs(os.path.dirname(ts_path), exist_ok=True)
    with open(ts_path, "w", encoding="utf-8") as f:
        f.write(
            "// 由 build.py 自动生成，勿手改。\n"
            "export const translations: Record<string, Record<string, string>> = "
            + json.dumps(data, ensure_ascii=False, indent=2)
            + ";\n"
        )

    route_dir = os.path.join(FUNCTIONS_DIR, "api", "i18n")
    os.makedirs(route_dir, exist_ok=True)
    with open(os.path.join(route_dir, "[lang].ts"), "w", encoding="utf-8") as f:
        f.write(
            '// 由 build.py 自动生成，勿手改。\n'
            'import { translations } from "../../_data/i18n";\n'
            "\n"
            "export const onRequestGet = ({ params }: { params: Record<string, string> }) => {\n"
            "  const lang = String((params as { lang?: string }).lang ?? \"\");\n"
            "  const dict = translations[lang];\n"
            "  if (!dict) {\n"
            '    return new Response(JSON.stringify({ error: "unsupported language" }), {\n'
            "      status: 404,\n"
            '      headers: { "Content-Type": "application/json" },\n'
            "    });\n"
            "  }\n"
            "  return new Response(JSON.stringify(dict), {\n"
            "    status: 200,\n"
            '    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },\n'
            "  });\n"
            "};\n"
        )


def main() -> int:
    # 引入 Flask app（本机依赖齐全；渲染完不启动服务）
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import app as appmod

    # 清空并重建输出目录（public/ 为纯生成产物）
    if os.path.isdir(PUBLIC_DIR):
        shutil.rmtree(PUBLIC_DIR)
    os.makedirs(PUBLIC_DIR)

    # 1) 每个语言渲染所有公开页面
    for lang in LANGS:
        lang_dir = os.path.join(PUBLIC_DIR, lang)
        os.makedirs(lang_dir, exist_ok=True)
        for template, filename, path in PAGES:
            html = render_page(appmod, template, path, lang)
            with open(os.path.join(lang_dir, filename), "w", encoding="utf-8") as f:
                f.write(html)
        print(f"[build] {lang} rendered", flush=True)

    # 3) 静态资源镜像
    shutil.copytree(STATIC_DIR, os.path.join(PUBLIC_DIR, "static"))
    # 门禁验证页引用的根路径 logo（放行路径之一）
    shutil.copy2(
        os.path.join(STATIC_DIR, "icons", "Limooo-xtext.webp"),
        os.path.join(PUBLIC_DIR, "Limooo-xtext.webp"),
    )

    # 4) i18n Functions（前端语言切换接口）
    write_i18n_functions()

    # 保留 .gitkeep（git 只跟踪它，生成内容不入库）
    with open(os.path.join(PUBLIC_DIR, ".gitkeep"), "w", encoding="utf-8"):
        pass

    total = 0
    for root, _dirs, files in os.walk(PUBLIC_DIR):
        total += len(files)
    print(f"[build] done, {total} files in public/", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
