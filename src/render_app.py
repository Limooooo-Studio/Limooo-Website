"""Limooo 构建期只读渲染应用。

构建静态页面时不需要启动 Flask 业务应用，也不需要读取生产密钥、创建
SQLite 数据库或初始化路由。这里提供一个最小 Flask 应用，只注册模板所需
的 i18n 上下文，供 ``src/build.py`` 预渲染使用。
"""

from __future__ import annotations

import json
import os

from flask import Flask, g

from config import (
    DEFAULT_LANG,
    GATE_HOST,
    IMAGE_ASSET_BASE_URL,
    IMAGE_WATERMARK_BASE_URL,
    KEY_FALLBACK_LANG,
    LOCALES_DIR,
    SOURCE_REPO_URL,
    STATIC_DIR,
    SUPPORTED_LANGS,
    TEMPLATES_DIR,
)


def load_translations() -> dict[str, dict[str, str]]:
    """读取全部语言 JSON；构建期缺少翻译文件必须失败，不能静默降级。"""
    translations: dict[str, dict[str, str]] = {}
    for lang in SUPPORTED_LANGS:
        path = os.path.join(LOCALES_DIR, f"{lang}.json")
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"无法读取翻译文件 {path}: {exc}") from exc
        if not isinstance(data, dict) or not all(isinstance(v, str) for v in data.values()):
            raise RuntimeError(f"翻译文件格式错误（应为字符串字典）: {path}")
        translations[lang] = data
    return translations


def create_render_app() -> Flask:
    """创建只包含模板与 i18n 上下文的 Flask 应用。"""
    app = Flask(
        __name__,
        template_folder=str(TEMPLATES_DIR),
        static_folder=str(STATIC_DIR),
    )
    translations = load_translations()

    def translate(key: str, **kwargs: object) -> str:
        lang = getattr(g, "lang", DEFAULT_LANG)
        value = translations.get(lang, {}).get(
            key,
            translations.get(KEY_FALLBACK_LANG, {}).get(key, key),
        )
        if kwargs:
            try:
                return str(value).format(**kwargs)
            except (KeyError, IndexError, ValueError):
                return value
        return value

    @app.context_processor
    def inject_i18n() -> dict[str, object]:
        lang = getattr(g, "lang", DEFAULT_LANG)
        return {
            "_": translate,
            "translations": translations.get(lang, {}),
            "gate_url": f"https://{GATE_HOST}/__gate",
            "image_asset_base": IMAGE_ASSET_BASE_URL,
            "image_watermark_base": IMAGE_WATERMARK_BASE_URL,
            "source_url": SOURCE_REPO_URL,
        }

    return app


RENDER_APP = create_render_app()
