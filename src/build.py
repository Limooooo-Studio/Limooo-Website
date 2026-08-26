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

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = ImageDraw = None

from config import (
    BASE_DIR,
    BASE_URL,
    GATE_HOST,
    LANG_COOKIE,
    LANG_COOKIE_MAX_AGE,
    LOCALES_DIR,
    PREVIEW_DIR,
    PUBLIC_DIR,
    REDIRECT_PRELOAD_IMAGES,
    ROOT_DOMAIN,
    STATIC_DIR,
    SUPPORTED_LANGS as LANGS,
)

FUNCTIONS_DIR = os.path.join(BASE_DIR, "functions")


CONTRACT_PATH = os.path.join(BASE_DIR, "config-contract.json")

# (模板, 输出文件名, 渲染路径) —— 用 Host: limooo.cn 渲染（is_prod=True），
# 导航链接保留子域绝对地址（limooo.cn / services.limooo.cn / contact.limooo.cn），
# 由中间件按主机名把对应语言页面吐到干净 URL，不做语言路径前缀。
PAGES = (
    ("index.html", "index.html", "/", None),
    ("services.html", "services.html", "/services", None),
    ("contact.html", "contact.html", "/contact", None),
    # images.limooo.cn 门面页（继承 base.html），由中间件按主机名吐出到 / 与三个前端路径
    ("images.html", "images.html", "/images", None),
    # 子域专属管理页（visitor.limooo.cn / appleid.limooo.cn），由中间件按主机名吐出
    ("visitor.html", "visitor.html", "/visitor", None),
    ("appleid.html", "appleid.html", "/appleid", None),
    # 统一跳转页（redirect.limooo.cn）：预渲染默认目标（主站首页），实际跳转参数由中间件拼接
    ("redirect.html", "redirect.html", "/r", "redirect"),
)

GATE_I18N_KEYS = (
    ("title", "gate_title"),
    ("heading", "gate_heading"),
    ("location", "gate_location"),
    ("ip", "gate_ip"),
    ("ray", "gate_ray"),
    ("foot", "gate_foot"),
    ("lang_aria", "gate_lang_aria"),
    ("theme_aria", "gate_theme_aria"),
    ("footer_rights", "footer_rights"),
    ("footer_source", "footer_source"),
    ("error_sitekey", "gate_error_sitekey"),
    ("error_invalid", "gate_error_invalid"),
    ("error_unavailable", "gate_error_unavailable"),
    ("error_failed", "gate_error_failed"),
)


def _load_gate_i18n() -> dict[str, dict[str, str]]:
    """从 locales/*.json 读取门禁文案，替代 build.py 中的硬编码字典。"""
    result: dict[str, dict[str, str]] = {}
    for lang in LANGS:
        path = os.path.join(LOCALES_DIR, f"{lang}.json")
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"无法读取门禁文案 {path}: {exc}") from exc
        texts = {}
        for output_key, locale_key in GATE_I18N_KEYS:
            value = data.get(locale_key)
            if not isinstance(value, str) or not value:
                raise RuntimeError(f"{path} 缺少门禁文案字段: {locale_key}")
            texts[output_key] = value
        result[lang] = texts
    return result

GATE_I18N = _load_gate_i18n()


def render_page(appmod, template: str, path: str, lang: str, extra=None) -> str:
    """用 Flask 渲染上下文渲染单个页面（Host 固定为 limooo.cn）"""
    kwargs = {}
    if extra == "redirect":
        # 预渲染默认跳转目标；实际登录/登出回跳由中间件动态拼接 to 参数
        kwargs = {
            "to": f"{BASE_URL}/",
            "preload": True,
            "preload_images": appmod.REDIRECT_PRELOAD_IMAGES,
        }
    with appmod.app.test_request_context(path, headers={"Host": ROOT_DOMAIN}):
        appmod.g.lang = lang
        html = appmod.render_template(template, **kwargs)
    # 模板中 lang 固定为合法静态值以通过静态检查；构建时替换为实际语言
    html = html.replace("<html lang=\"zh-cn\">", f"<html lang=\"{lang}\">", 1)
    # 相对资源统一加根斜杠：模板里是 src="static/..."，在 /zh-cn 这类子路径下
    # 会解析错位，改成 /static/... 后任何路径都正确（配合中间件干净 URL）
    html = html.replace('src="static/', 'src="/static/')
    html = html.replace('href="static/', 'href="/static/')
    # 记住当前语言，保证根路径重定向时语言不跳变
    cookie_js = (
        "<script>try{document.cookie='" + LANG_COOKIE + "=" + lang +
        ";path=/;max-age=" + str(LANG_COOKIE_MAX_AGE) +
        ";SameSite=Lax'+(location.protocol==='https:'?';Secure':'')}"
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
    with appmod.app.test_request_context("/__gate", headers={"Host": GATE_HOST}):
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
            gate_i18n=GATE_I18N,
            host="",
            next="/",
        )
    html = html.replace("<html lang=\"zh-cn\">", f"<html lang=\"{lang}\">", 1)
    return html


def preview_i18n_patch() -> str:
    """预览版语言切换补丁：内联 4 语言字典，切换语言不依赖 /api/i18n"""
    data: dict[str, dict[str, str]] = {}
    for lang in LANGS:
        with open(os.path.join(LOCALES_DIR, f"{lang}.json"), encoding="utf-8") as f:
            data[lang] = json.load(f)
    # 内联到 <script> 前转义 </script> 闭合序列，防止翻译文案意外闭合脚本
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return (
        "<script>"
        "(function(){"
        "var ALL=" + payload + ";"
        "window.__PREVIEW_I18N__=ALL;"
        "if (typeof I18N_CACHE === 'undefined') { window.I18N_CACHE = {}; }"
        "Object.keys(ALL).forEach(function(l){I18N_CACHE[l]=ALL[l];});"
        "window.fetchI18n=function(lang,cb){cb(window.__PREVIEW_I18N__[lang]||null);};"
        "})();"
        "</script>"
    )


def write_config_functions() -> None:
    """从 config-contract.json 生成 Pages 侧常量模块（唯一事实源）。"""
    with open(CONTRACT_PATH, encoding="utf-8") as f:
        contract = json.load(f)
    root = contract["root_domain"]

    lines = [
        "/** 由 build.py 自动生成，勿手改；修改配置请编辑 config-contract.json。 */",
        "export const CONTRACT = " + json.dumps(contract, ensure_ascii=False, indent=2) + " as const;",
        "",
        "export const ROOT_DOMAIN = CONTRACT.root_domain;",
        "export const BASE_URL = `https://${ROOT_DOMAIN}`;",
        "export const WWW_HOSTNAME = `www.${ROOT_DOMAIN}`;",
        "export const SERVICES_HOSTNAME = `services.${ROOT_DOMAIN}`;",
        "export const CONTACT_HOSTNAME = `contact.${ROOT_DOMAIN}`;",
        "export const VISITOR_HOSTNAME = `visitor.${ROOT_DOMAIN}`;",
        "export const APPLEID_HOSTNAME = `appleid.${ROOT_DOMAIN}`;",
        "export const REDIRECT_HOSTNAME = `redirect.${ROOT_DOMAIN}`;",
        "export const GATE_HOSTNAME = `auth.${ROOT_DOMAIN}`;",
        "export const IDENTITY_HOSTNAME = `identity.${ROOT_DOMAIN}`;",
        "export const IMAGES_HOSTNAME = `images.${ROOT_DOMAIN}`;",
        "export const GATE_HOST = GATE_HOSTNAME;",
        "export const REDIRECT_HOST = `https://${REDIRECT_HOSTNAME}/`;",
        "export const IDENTITY_URL = `https://${IDENTITY_HOSTNAME}`;",
        "export const IMAGE_BASE = `https://${IMAGES_HOSTNAME}`;",
        "export const APPLEID_DOMAIN = `@${APPLEID_HOSTNAME}`;",
        "export const PUBLIC_HOSTS: Set<string> = new Set(CONTRACT.public_hosts);",
        "export const SUPPORTED_LANGS = CONTRACT.supported_langs;",
        "export const DEFAULT_LANG = CONTRACT.default_lang;",
        "export const KEY_FALLBACK_LANG = CONTRACT.key_fallback_lang;",
        "export const LANG_COOKIE = CONTRACT.lang_cookie;",
        "export const LANG_COOKIE_MAX_AGE = CONTRACT.lang_cookie_max_age;",
        "export const GATE_COOKIE = CONTRACT.gate_cookie;",
        "export const SESSION_COOKIE = CONTRACT.session_cookie;",
        "export const PENDING_COOKIE = CONTRACT.pending_cookie;",
        "export const GATE_TTL_SECONDS = CONTRACT.gate_ttl_seconds;",
        "export const SESSION_TTL_SECONDS = CONTRACT.session_ttl_seconds;",
        "export const PENDING_TTL_SECONDS = CONTRACT.pending_ttl_seconds;",
        "export const AUTHENTIK_PROVIDER_SLUG = CONTRACT.authentik_provider_slug;",
        "export const AUTHENTIK_ADMIN_GROUPS_DEFAULT = CONTRACT.authentik_admin_groups.join(\", \");",
        "",
    ]
    ts_path = os.path.join(FUNCTIONS_DIR, "_lib", "config.ts")
    os.makedirs(os.path.dirname(ts_path), exist_ok=True)
    with open(ts_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("[build] config functions generated", flush=True)


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


def write_runtime_functions() -> None:
    """把门禁/跳转页共享文案与预热图片生成 Pages 端独立模块，消除 middleware 重复维护。"""
    redirect_i18n: dict[str, dict[str, str]] = {}
    for lang in LANGS:
        with open(os.path.join(LOCALES_DIR, f"{lang}.json"), encoding="utf-8") as f:
            d = json.load(f)
        redirect_i18n[lang] = {
            "title": d.get("redirect_title", "正在跳转"),
            "text": d.get("redirect_text", "正在跳转..."),
            "footer_rights": d.get("footer_rights", "保留所有权利"),
            "footer_source": d.get("footer_source", "根据 AGPL-3.0 许可证发布"),
        }
    output = [
        "// 由 build.py 自动生成，勿手改。",
        "export const GATE_I18N: Record<string, Record<string, string>> = "
        + json.dumps(GATE_I18N, ensure_ascii=False, indent=2)
        + ";",
        "export const REDIRECT_I18N: Record<string, { title: string; text: string; footer_rights: string; footer_source: string }> = "
        + json.dumps(redirect_i18n, ensure_ascii=False, indent=2)
        + ";",
        "export const REDIRECT_PRELOAD_IMAGES = "
        + json.dumps(REDIRECT_PRELOAD_IMAGES, ensure_ascii=False, indent=2)
        + ";",
    ]
    ts_path = os.path.join(FUNCTIONS_DIR, "_data", "runtime.ts")
    os.makedirs(os.path.dirname(ts_path), exist_ok=True)
    with open(ts_path, "w", encoding="utf-8") as f:
        f.write("\n".join(output) + "\n")
    print("[build] runtime functions generated", flush=True)


def generate_watermarks() -> int:
    """为 image.limooo.cn Worker 生成左下角水印变体到 public/static/wm/。

    规则（与 Worker 里的 shouldWatermark 保持一致）：
      - 只处理 portfolio/ 下的 png / jpg / jpeg / webp
      - 其他路径（icons / qr-codes 等）不生成水印变体
    水印尺寸：图片短边的 25%（下限 96px），左下角 2% 边距（下限 12px）。
    水印原文件约 40% 透明度，这里提高到约 72%，并垫一块半透明深色圆角底衬，
    保证浅色照片上也能看清。想调整显眼程度直接改下面的常量。
    """
    # 显眼程度参数（可按喜好调整）
    WATERMARK_SCALE = 0.25       # 水印宽度 = 图片短边的比例
    WATERMARK_MIN_W = 96         # 水印宽度下限（px）
    WATERMARK_ALPHA_BOOST = 1.8  # 水印本身透明度增强系数（40% → ~72%）
    BACKDROP_ALPHA = 105         # 深色底衬不透明度（0-255，0 = 不要底衬）
    PAD_RATIO = 0.08             # 底衬相对水印宽度的内边距

    if Image is None or ImageDraw is None:
        portfolio_dir = os.path.join(STATIC_DIR, "portfolio")
        if os.path.isdir(portfolio_dir) and any(
            name.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
            for name in os.listdir(portfolio_dir)
        ):
            raise RuntimeError(
                "Pillow 未安装，无法生成作品集水印。请先执行 "
                "`pip install -r ops/requirements.txt` 再运行 build.py。"
            )
        print("[build] 没有可水印化的作品集文件，跳过 Pillow 检查", flush=True)
        return 0

    wm_path = os.path.join(STATIC_DIR, "icons", "Limooo-watermark.webp")
    out_root = os.path.join(PUBLIC_DIR, "static", "wm")
    os.makedirs(out_root, exist_ok=True)

    wm = Image.open(wm_path).convert("RGBA")
    wm_w0, wm_h0 = wm.size
    count = 0

    for root, _dirs, files in os.walk(STATIC_DIR):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), STATIC_DIR)
            # 只给作品集图片加水印
            if not rel.replace(os.sep, "/").startswith("portfolio/"):
                continue
            if not re.search(r"\.(png|jpe?g|webp)$", name, re.I):
                continue
            try:
                with Image.open(os.path.join(root, name)) as opened:
                    im = opened.convert("RGBA")
            except Exception as exc:  # 无法解码的图直接跳过
                print(f"[build] watermark skip {rel}: {exc}", flush=True)
                continue

            base = min(im.size)
            target_w = max(WATERMARK_MIN_W, round(base * WATERMARK_SCALE))
            wm_h = max(1, round(wm_h0 * target_w / wm_w0))
            margin = max(12, round(base * 0.02))
            resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
            wm_resized = wm.resize((target_w, wm_h), resampling)
            # 提高水印本身的不透明度（原文件约 40% → ~72%）
            if WATERMARK_ALPHA_BOOST != 1:
                r, g, b, a = wm_resized.split()
                a = a.point(lambda v: min(255, int(round(float(v) * WATERMARK_ALPHA_BOOST))))
                wm_resized = Image.merge("RGBA", (r, g, b, a))

            canvas = im.copy()
            # 半透明深色圆角底衬：浅色照片上水印也清晰
            if BACKDROP_ALPHA > 0:
                pad = max(8, round(target_w * PAD_RATIO))
                bg = Image.new("RGBA", im.size, (0, 0, 0, 0))
                box = (
                    max(0, margin - pad),
                    max(0, im.size[1] - wm_h - margin - pad),
                    min(im.size[0], margin + target_w + pad),
                    im.size[1] - margin + pad,
                )
                ImageDraw.Draw(bg).rounded_rectangle(
                    box, radius=max(8, pad), fill=(12, 16, 20, BACKDROP_ALPHA)
                )
                canvas = Image.alpha_composite(canvas, bg)
            canvas.alpha_composite(
                wm_resized,
                (margin, im.size[1] - wm_h - margin),
            )

            ext = name.rsplit(".", 1)[-1].lower()
            if ext == "png":
                fmt, save_im, kwargs = "PNG", canvas, {}
            elif ext in ("jpg", "jpeg"):
                fmt, save_im, kwargs = "JPEG", canvas.convert("RGB"), {"quality": 92}
            else:
                fmt, save_im, kwargs = "WEBP", canvas.convert("RGB"), {"quality": 92}

            out_path = os.path.join(out_root, rel)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            save_im.save(out_path, fmt, **kwargs)
            count += 1

    print(f"[build] watermarked variants: {count}", flush=True)
    return count


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
    # 3.1) 水印变体（image.limooo.cn Worker 按 Referer 选择原图 / 水印图）
    generate_watermarks()
    # 门禁验证页引用的根路径 logo（放行路径之一）
    shutil.copy2(
        os.path.join(STATIC_DIR, "icons", "Limooo-xtext.webp"),
        os.path.join(PUBLIC_DIR, "Limooo-xtext.webp"),
    )

    # 4) i18n Functions（前端语言切换接口）
    write_config_functions()
    write_i18n_functions()
    write_runtime_functions()

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
            # 资源引用本地化：https://limooo.cn/static/... 与
            # https://image.limooo.cn/...（不带 /static 前缀）→ ../static/...
            # （只替换 HTML 标签属性，不碰 JS 里的绝对 URL）
            html = re.sub(
                r'(src|href|data-qr)="https://(?:limooo\.cn/static|image\.limooo\.cn)/',
                r'\1="../static/',
                html,
            )
            # 内联 CSS 里的根路径资源（门禁页 @font-face 的 url(/static/...)）同步本地化
            html = html.replace("url(/static/", "url(../static/")
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
            # redirect 预览：静止展示跳转页，不自动跳走
            if name == "redirect.html":
                html = re.sub(r'<meta http-equiv="refresh"[^>]*>', '', html)
                html = html.replace(
                    "function go() { location.replace(target); }",
                    "function go() {}",
                )
            # 语言切换本地化：内联 4 语言字典（页面内可切换语言，无需 /api/i18n）
            html = html.replace("</body>", preview_i18n_patch() + "</body>")
            with open(os.path.join(PREVIEW_OUT, name), "w", encoding="utf-8") as f:
                f.write(html)
    # 预览索引（列出所有子域页面，模板在 Flask/src/templates/preview.html）
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
