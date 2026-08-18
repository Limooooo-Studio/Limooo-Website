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
PREVIEW_DIR = os.path.join(BASE_DIR, "preview")
STATIC_DIR = os.path.join(BASE_DIR, "static")
LOCALES_DIR = os.path.join(BASE_DIR, "locales")
FUNCTIONS_DIR = os.path.join(BASE_DIR, "functions")

# 语言代码统一小写（与 Cloudflare Turnstile 的 language 参数格式一致）
LANGS = ("zh-cn", "en-us", "ja-jp", "ko-kr")
DEFAULT_LANG = "en-us"

# (模板, 输出文件名, 渲染路径) —— 用 Host: limooo.cn 渲染（is_prod=True），
# 导航链接保留子域绝对地址（limooo.cn / services.limooo.cn / contact.limooo.cn），
# 由中间件按主机名把对应语言页面吐到干净 URL，不做语言路径前缀。
PAGES = (
    ("index.html", "index.html", "/", None),
    ("services.html", "services.html", "/services", None),
    ("contact.html", "contact.html", "/contact", None),
    # 子域专属管理页（visitor.limooo.cn / appleid.limooo.cn），由中间件按主机名吐出
    ("visitor.html", "visitor.html", "/visitor", None),
    ("appleid.html", "appleid.html", "/appleid", None),
    # 统一跳转页（redirect.limooo.cn）：预渲染默认目标（主站首页），实际跳转参数由中间件拼接
    ("redirect.html", "redirect.html", "/r", "redirect"),
)

# 门禁页文案（与 functions/_middleware.ts 的 GATE_I18N 保持一致）
GATE_I18N = {
    "zh-cn": {
        "title": "人机验证 · Limooo",
        "heading": "请完成人机验证后再访问本站",
        "location": "位置",
        "ip": "IP",
        "ray": "Ray ID",
        "foot": "由 Limooo 边缘安全提供保护",
        "lang_aria": "切换语言",
        "theme_aria": "切换主题",
        "error_sitekey": "服务配置错误：未设置 TURNSTILE_SITEKEY。",
        "error_invalid": "请求无效，请重试。",
        "error_unavailable": "验证服务暂时不可用，请稍后重试。",
        "error_failed": "验证未通过，请重试。",
    },
    "en-us": {
        "title": "Verify you are human · Limooo",
        "heading": "Please complete this CAPTCHA to access the site.",
        "location": "Location",
        "ip": "IP",
        "ray": "Ray ID",
        "foot": "Secured by Limooo Edge Security",
        "lang_aria": "Switch language",
        "theme_aria": "Toggle theme",
        "error_sitekey": "Server configuration error: TURNSTILE_SITEKEY is not set.",
        "error_invalid": "Invalid request. Please try again.",
        "error_unavailable": "Verification service temporarily unavailable. Please try again in a moment.",
        "error_failed": "Verification failed. Please try again.",
    },
    "ja-jp": {
        "title": "人認証 · Limooo",
        "heading": "このサイトにアクセスするには、人認証を完了してください",
        "location": "場所",
        "ip": "IP",
        "ray": "Ray ID",
        "foot": "Limooo Edge Security により保護されています",
        "lang_aria": "言語切替",
        "theme_aria": "テーマ切替",
        "error_sitekey": "サーバー設定エラー：TURNSTILE_SITEKEY が設定されていません。",
        "error_invalid": "リクエストが無効です。もう一度お試しください。",
        "error_unavailable": "認証サービスが一時的に利用できません。しばらくしてからもう一度お試しください。",
        "error_failed": "認証に失敗しました。もう一度お試しください。",
    },
    "ko-kr": {
        "title": "휴먼 인증 · Limooo",
        "heading": "사이트에 접속하려면 인증을 완료해 주세요",
        "location": "위치",
        "ip": "IP",
        "ray": "Ray ID",
        "foot": "Limooo Edge Security가 보호합니다",
        "lang_aria": "언어 전환",
        "theme_aria": "테마 전환",
        "error_sitekey": "서버 설정 오류: TURNSTILE_SITEKEY가 설정되지 않았습니다.",
        "error_invalid": "잘못된 요청입니다. 다시 시도해 주세요.",
        "error_unavailable": "인증 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        "error_failed": "인증에 실패했습니다. 다시 시도해 주세요.",
    },
}


def render_page(appmod, template: str, path: str, lang: str, extra=None) -> str:
    """用 Flask 渲染上下文渲染单个页面（Host 固定为 limooo.cn）"""
    kwargs = {}
    if extra == "redirect":
        # 预渲染默认跳转目标；实际登录/登出回跳由中间件动态拼接 to 参数
        kwargs = {
            "to": "https://limooo.cn/",
            "preload": True,
            "preload_images": appmod.REDIRECT_PRELOAD_IMAGES,
        }
    with appmod.app.test_request_context(path, headers={"Host": "limooo.cn"}):
        appmod.g.lang = lang
        html = appmod.render_template(template, **kwargs)
    # 相对资源统一加根斜杠：模板里是 src="static/..."，在 /zh-cn 这类子路径下
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


def render_gate(appmod, lang: str) -> str:
    """按语言预渲染人机验证门禁页（auth.limooo.cn/__gate）"""
    t = GATE_I18N[lang]
    sitekey = os.environ.get("TURNSTILE_SITEKEY", "")
    if sitekey:
        turnstile_html = '<div id="turnstile-wrap"></div>'
        turnstile_src = (
            '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?'
            'onload=onloadTurnstileCallback" defer></script>'
        )
    else:
        turnstile_html = (
            f'<div class="error" data-i18n="error_sitekey">{t["error_sitekey"]}</div>'
        )
        turnstile_src = ""
    with appmod.app.test_request_context("/__gate", headers={"Host": "auth.limooo.cn"}):
        appmod.g.lang = lang
        html = appmod.render_template(
            "auth.html",
            lang=lang,
            title=t["title"],
            heading=t["heading"],
            location=t["location"],
            ip=t["ip"],
            ray=t["ray"],
            foot=t["foot"],
            lang_aria=t["lang_aria"],
            theme_aria=t["theme_aria"],
            error_html="",
            turnstile_html=turnstile_html,
            turnstile_src=turnstile_src,
            sitekey=sitekey,
            gate_i18n=json.dumps(GATE_I18N, ensure_ascii=False),
            host="",
            next="/",
        )
    return html


def preview_i18n_patch() -> str:
    """预览版语言切换补丁：内联 4 语言字典，切换语言不依赖 /api/i18n"""
    data: dict[str, dict[str, str]] = {}
    for lang in LANGS:
        with open(os.path.join(LOCALES_DIR, f"{lang}.json"), encoding="utf-8") as f:
            data[lang] = json.load(f)
    return (
        "<script>"
        "(function(){"
        "var ALL=" + json.dumps(data, ensure_ascii=False) + ";"
        'if (typeof I18N_CACHE === "undefined") { window.I18N_CACHE = {}; }'
        "Object.keys(ALL).forEach(function(l){I18N_CACHE[l]=ALL[l];});"
        "window.fetchI18n=function(lang,cb){cb(I18N_CACHE[lang]||null);};"
        "})();"
        "</script>"
    )


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
        for template, filename, path, extra in PAGES:
            html = render_page(appmod, template, path, lang, extra)
            with open(os.path.join(lang_dir, filename), "w", encoding="utf-8") as f:
                f.write(html)
        # 人机验证门禁页（auth.limooo.cn/__gate）
        with open(os.path.join(lang_dir, "auth.html"), "w", encoding="utf-8") as f:
            f.write(render_gate(appmod, lang))
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

    # 5) 子域预览（本地预览用，不入库）：生成的预览输出到 preview/templates/，
    #    每个子域页面一个文件（预览默认语言），不按语言分文件夹，
    #    并镜像 static/ 资源，HTML 里的图片引用改为本地相对路径（离线可看）
    PREVIEW_OUT = os.path.join(PREVIEW_DIR, "templates")
    if os.path.isdir(PREVIEW_DIR):
        shutil.rmtree(PREVIEW_DIR)
    os.makedirs(PREVIEW_OUT)
    shutil.copytree(STATIC_DIR, os.path.join(PREVIEW_DIR, "static"))
    PREVIEW_LANG = "zh-cn"
    src = os.path.join(PUBLIC_DIR, PREVIEW_LANG)
    for name in os.listdir(src):
        if name.endswith(".html"):
            html = open(os.path.join(src, name), encoding="utf-8").read()
            # 资源引用本地化：https://limooo.cn/static/... → ../static/...
            # （只替换 HTML 标签属性，不碰 JS 里的绝对 URL）
            html = re.sub(
                r'(src|href|data-qr)="https://limooo\.cn/static/',
                r'\1="../static/',
                html,
            )
            html = html.replace(
                'src="/Limooo-xtext.webp"',
                'src="../static/icons/Limooo-xtext.webp"',
            )
            # 站内导航本地化：https://<子域>.limooo.cn → 同目录本地文件
            for sub, page in (
                ("services", "services.html"),
                ("contact", "contact.html"),
                ("visitor", "visitor.html"),
                ("appleid", "appleid.html"),
            ):
                html = re.sub(rf'href="https://{sub}\.limooo\.cn/?', f'href="{page}"', html)
            html = re.sub(r'href="https://limooo\.cn/?', 'href="index.html"', html)
            # redirect 预览默认目标也指向本地首页
            html = re.sub(r'url=https://limooo\.cn/', 'url=index.html', html)
            html = html.replace('"https://limooo.cn/"', '"index.html"')
            # 语言切换本地化：内联 4 语言字典（页面内可切换语言，无需 /api/i18n）
            html = html.replace("</body>", preview_i18n_patch() + "</body>")
            with open(os.path.join(PREVIEW_OUT, name), "w", encoding="utf-8") as f:
                f.write(html)
    # 预览索引（列出所有子域页面，模板在 Flask/templates/preview.html）
    with appmod.app.test_request_context("/", headers={"Host": "limooo.cn"}):
        index_html = appmod.render_template(
            "preview.html",
            pages=[
                "index.html",
                "services.html",
                "contact.html",
                "visitor.html",
                "appleid.html",
                "redirect.html",
                "auth.html",
            ],
        )
    with open(os.path.join(PREVIEW_OUT, "preview.html"), "w", encoding="utf-8") as f:
        f.write(index_html)
    with open(os.path.join(PREVIEW_DIR, ".gitkeep"), "w", encoding="utf-8") as f:
        pass
    print(f"[build] preview generated for {len(LANGS)} languages", flush=True)

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
