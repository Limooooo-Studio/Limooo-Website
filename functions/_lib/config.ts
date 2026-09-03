/** 由 build.py 自动生成，勿手改；修改配置请编辑 config-contract.json。 */
export const CONTRACT = {
  "schema_version": 1,
  "root_domain": "limooo.cn",
  "supported_langs": [
    "zh-cn",
    "en-us",
    "ja-jp",
    "ko-kr"
  ],
  "default_lang": "en-us",
  "key_fallback_lang": "zh-cn",
  "lang_cookie": "user_lang_preference",
  "lang_cookie_max_age": 31536000,
  "theme_cookie": "limooo_theme",
  "theme_cookie_max_age": 31536000,
  "gate_cookie": "__gate",
  "session_cookie": "limooo_session_v2",
  "pending_cookie": "limooo_pending_v2",
  "csrf_cookie": "limooo_csrf",
  "gate_ttl_seconds": 3600,
  "session_ttl_seconds": 604800,
  "pending_ttl_seconds": 600,
  "public_hosts": [
    "limooo.cn",
    "www.limooo.cn",
    "services.limooo.cn",
    "contact.limooo.cn",
    "visitor.limooo.cn",
    "appleid.limooo.cn",
    "auth.limooo.cn",
    "redirect.limooo.cn",
    "image.limooo.cn",
    "images.limooo.cn",
    "status.limooo.cn",
    "*.limooo.cn"
  ],
  "managed_hosts": [
    "limooo.cn",
    "www.limooo.cn",
    "services.limooo.cn",
    "contact.limooo.cn",
    "visitor.limooo.cn",
    "appleid.limooo.cn",
    "auth.limooo.cn",
    "redirect.limooo.cn",
    "images.limooo.cn",
    "image.limooo.cn"
  ],
  "page_routes": {
    "limooo.cn": {
      "/": "index.html",
      "/index.html": "index.html",
      "/services": "services.html",
      "/contact": "contact.html"
    },
    "www.limooo.cn": {
      "/": "index.html",
      "/index.html": "index.html",
      "/services": "services.html",
      "/contact": "contact.html"
    },
    "services.limooo.cn": {
      "/": "services.html",
      "/index.html": "services.html",
      "/services": "services.html"
    },
    "contact.limooo.cn": {
      "/": "contact.html",
      "/index.html": "contact.html",
      "/contact": "contact.html"
    },
    "visitor.limooo.cn": {
      "/": "visitor.html",
      "/index.html": "visitor.html",
      "/visitor": "visitor.html"
    },
    "appleid.limooo.cn": {
      "/": "appleid.html",
      "/index.html": "appleid.html",
      "/appleid": "appleid.html"
    },
    "auth.limooo.cn": {
      "/__gate": "auth.html"
    },
    "redirect.limooo.cn": {
      "/": "redirect.html",
      "/r": "redirect.html"
    },
    "images.limooo.cn": {
      "/": "images.html",
      "/index.html": "images.html",
      "/portfolio": "images.html",
      "/qr-codes": "images.html",
      "/icons": "images.html"
    }
  },
  "image_asset_host": "images.limooo.cn",
  "image_watermark_host": "image.limooo.cn",
  "gate_trust": {
    "verified_bot": true,
    "ua_allowlist_enabled": false
  },
  "observability_hmac_env": "OBSERVABILITY_HMAC_KEY",
  "whitelist_file": "data/whitelist.txt",
  "authentik_host": "admin.limooo.cn",
  "authentik_provider_slug": "visitor",
  "authentik_admin_groups": [
    "authentik Admins"
  ]
} as const;

export const ROOT_DOMAIN = CONTRACT.root_domain;
export const BASE_URL = `https://${ROOT_DOMAIN}`;
export const WWW_HOSTNAME = `www.${ROOT_DOMAIN}`;
export const SERVICES_HOSTNAME = `services.${ROOT_DOMAIN}`;
export const CONTACT_HOSTNAME = `contact.${ROOT_DOMAIN}`;
export const VISITOR_HOSTNAME = `visitor.${ROOT_DOMAIN}`;
export const APPLEID_HOSTNAME = `appleid.${ROOT_DOMAIN}`;
export const REDIRECT_HOSTNAME = `redirect.${ROOT_DOMAIN}`;
export const GATE_HOSTNAME = `auth.${ROOT_DOMAIN}`;
export const AUTHENTIK_HOSTNAME = "admin.limooo.cn";
export const IDENTITY_HOSTNAME = AUTHENTIK_HOSTNAME;
export const IMAGES_HOSTNAME = `images.${ROOT_DOMAIN}`;
export const GATE_HOST = GATE_HOSTNAME;
export const REDIRECT_HOST = `https://${REDIRECT_HOSTNAME}/`;
export const IDENTITY_URL = `https://${IDENTITY_HOSTNAME}`;
export const AUTHENTIK_URL = `https://${AUTHENTIK_HOSTNAME}`;
export const IMAGE_BASE = `https://${IMAGES_HOSTNAME}`;
export const APPLEID_DOMAIN = `@${APPLEID_HOSTNAME}`;
export const PUBLIC_HOSTS: Set<string> = new Set(CONTRACT.public_hosts);
export const MANAGED_HOSTS: Set<string> = new Set(CONTRACT.managed_hosts);
export const PAGE_ROUTES: Record<string, Record<string, string>> = CONTRACT.page_routes;
export const IMAGE_ASSET_HOSTNAME = CONTRACT.image_asset_host;
export const IMAGE_WATERMARK_HOSTNAME = CONTRACT.image_watermark_host;
export const IMAGE_ASSET_BASE = `https://${IMAGE_ASSET_HOSTNAME}`;
export const IMAGE_WATERMARK_BASE = `https://${IMAGE_WATERMARK_HOSTNAME}`;
export const GATE_TRUST = CONTRACT.gate_trust;
export const OBSERVABILITY_HMAC_ENV = CONTRACT.observability_hmac_env;
export const WHITELIST_FILE = CONTRACT.whitelist_file;
export const SUPPORTED_LANGS = CONTRACT.supported_langs;
export const DEFAULT_LANG = CONTRACT.default_lang;
export const KEY_FALLBACK_LANG = CONTRACT.key_fallback_lang;
export const LANG_COOKIE = CONTRACT.lang_cookie;
export const LANG_COOKIE_MAX_AGE = CONTRACT.lang_cookie_max_age;
export const THEME_COOKIE = CONTRACT.theme_cookie;
export const THEME_COOKIE_MAX_AGE = CONTRACT.theme_cookie_max_age;
export const GATE_COOKIE = CONTRACT.gate_cookie;
export const SESSION_COOKIE = CONTRACT.session_cookie;
export const PENDING_COOKIE = CONTRACT.pending_cookie;
export const CSRF_COOKIE = CONTRACT.csrf_cookie;
export const GATE_TTL_SECONDS = CONTRACT.gate_ttl_seconds;
export const SESSION_TTL_SECONDS = CONTRACT.session_ttl_seconds;
export const PENDING_TTL_SECONDS = CONTRACT.pending_ttl_seconds;
export const AUTHENTIK_PROVIDER_SLUG = CONTRACT.authentik_provider_slug;
export const AUTHENTIK_ADMIN_GROUPS_DEFAULT = CONTRACT.authentik_admin_groups.join(", ");
