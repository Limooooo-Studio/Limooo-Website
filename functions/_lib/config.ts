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
  "gate_cookie": "__gate",
  "session_cookie": "limooo_session",
  "pending_cookie": "limooo_pending",
  "gate_ttl_seconds": 3600,
  "session_ttl_seconds": 604800,
  "pending_ttl_seconds": 600,
  "public_hosts": [
    "limooo.cn",
    "www.limooo.cn",
    "services.limooo.cn",
    "contact.limooo.cn",
    "identity.limooo.cn",
    "visitor.limooo.cn",
    "appleid.limooo.cn"
  ],
  "authentik_provider_slug": "limooo",
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
export const IDENTITY_HOSTNAME = `identity.${ROOT_DOMAIN}`;
export const IMAGES_HOSTNAME = `images.${ROOT_DOMAIN}`;
export const GATE_HOST = GATE_HOSTNAME;
export const REDIRECT_HOST = `https://${REDIRECT_HOSTNAME}/`;
export const IDENTITY_URL = `https://${IDENTITY_HOSTNAME}`;
export const IMAGE_BASE = `https://${IMAGES_HOSTNAME}`;
export const APPLEID_DOMAIN = `@${APPLEID_HOSTNAME}`;
export const PUBLIC_HOSTS: Set<string> = new Set(CONTRACT.public_hosts);
export const SUPPORTED_LANGS = CONTRACT.supported_langs;
export const DEFAULT_LANG = CONTRACT.default_lang;
export const KEY_FALLBACK_LANG = CONTRACT.key_fallback_lang;
export const LANG_COOKIE = CONTRACT.lang_cookie;
export const LANG_COOKIE_MAX_AGE = CONTRACT.lang_cookie_max_age;
export const GATE_COOKIE = CONTRACT.gate_cookie;
export const SESSION_COOKIE = CONTRACT.session_cookie;
export const PENDING_COOKIE = CONTRACT.pending_cookie;
export const GATE_TTL_SECONDS = CONTRACT.gate_ttl_seconds;
export const SESSION_TTL_SECONDS = CONTRACT.session_ttl_seconds;
export const PENDING_TTL_SECONDS = CONTRACT.pending_ttl_seconds;
export const AUTHENTIK_PROVIDER_SLUG = CONTRACT.authentik_provider_slug;
export const AUTHENTIK_ADMIN_GROUPS_DEFAULT = CONTRACT.authentik_admin_groups.join(", ");
