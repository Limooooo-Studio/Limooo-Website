/**
 * 与主站共享 cookie 的桥接层（docs.limooo.cn ↔ limooo.cn）。
 *
 * 主站 cookie（见 Flask/src/static/js/base.js 与 functions/_lib/routing.ts）：
 *   user_lang_preference = zh-cn | en-us | ja-jp | ko-kr   Domain=.limooo.cn
 *   limooo_theme         = light | dark                     Domain=.limooo.cn
 *
 * 这里做三件事：
 *   1. 读主站主题 cookie → 首次访问时喂给 VitePress appearance；
 *   2. 监控 VitePress 的深色切换 → 回写 limooo_theme；
 *   3. 路由变化时把当前语言前缀回写 user_lang_preference，
 *      并在进入站点根时按 cookie 偏好跳一次（每会话一次）。
 */

export const LANG_COOKIE = 'user_lang_preference'
export const THEME_COOKIE = 'limooo_theme'
export const APPEARANCE_KEY = 'vitepress-theme-appearance'

export const ROOT_LANG = 'zh-cn'
export const NON_ROOT_LANGS = ['en-us', 'ja-jp', 'ko-kr'] as const

const ROOT_DOMAIN = 'limooo.cn'
const COOKIE_MAX_AGE = 31536000
const REDIRECT_FLAG = 'limooo-docs-lang-redirect'

/** 在 <head> 里、VitePress 自己的 check-dark-mode 之前执行的同步脚本。 */
export const THEME_BOOTSTRAP_SCRIPT = `;(() => {
  try {
    if (localStorage.getItem('${APPEARANCE_KEY}')) return
    var m = document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=(light|dark)/)
    if (m) localStorage.setItem('${APPEARANCE_KEY}', m[1])
  } catch (e) {}
})()`

function cookieAttributes(): string {
  const host = location.hostname
  const domain =
    host === ROOT_DOMAIN || host.endsWith('.' + ROOT_DOMAIN)
      ? '; domain=.' + ROOT_DOMAIN
      : ''
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  return `; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}${domain}`
}

export function readCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')
  )
  return match ? decodeURIComponent(match[1]) : null
}

export function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}${cookieAttributes()}`
}

/** 从 URL 路径推导主站语言码（主站 cookie 的取值域）。 */
export function langFromPath(path: string): string {
  const segment = path.split('?')[0].split('/').filter(Boolean)[0]
  return (NON_ROOT_LANGS as readonly string[]).includes(segment)
    ? segment
    : ROOT_LANG
}

/** 把同一个页面换成另一种语言的路径。 */
export function pathForLang(path: string, lang: string): string {
  const parts = path.split('?')[0].split('/').filter(Boolean)
  if (parts.length && (NON_ROOT_LANGS as readonly string[]).includes(parts[0])) {
    parts.shift()
  }
  const rest = parts.length ? '/' + parts.join('/') : '/'
  return lang === ROOT_LANG ? rest : `/${lang}${rest}`
}

export function isValidLang(value: string | null): value is string {
  return value !== null &&
    (value === ROOT_LANG || (NON_ROOT_LANGS as readonly string[]).includes(value))
}

function syncLangCookie(path: string): void {
  const lang = langFromPath(path)
  if (readCookie(LANG_COOKIE) !== lang) writeCookie(LANG_COOKIE, lang)
}

function syncThemeCookie(): void {
  const value = document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light'
  if (readCookie(THEME_COOKIE) !== value) writeCookie(THEME_COOKIE, value)
}

function watchAppearance(): void {
  syncThemeCookie()
  new MutationObserver(syncThemeCookie).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })
}

interface RouterLike {
  onAfterRouteChange?: (to: string) => unknown
  go: (to: string) => unknown
}

export function installCookieBridge(router: RouterLike): void {
  if (typeof document === 'undefined') return

  watchAppearance()
  syncLangCookie(location.pathname)

  const previous = router.onAfterRouteChange
  router.onAfterRouteChange = async (to: string) => {
    await previous?.(to)
    syncLangCookie(to)
  }

  // 只从站点根跳一次：带语言前缀的深链保持用户显式选择。
  try {
    if (location.pathname === '/' && !sessionStorage.getItem(REDIRECT_FLAG)) {
      sessionStorage.setItem(REDIRECT_FLAG, '1')
      const preferred = readCookie(LANG_COOKIE)
      if (isValidLang(preferred) && preferred !== ROOT_LANG) {
        void router.go(pathForLang(location.pathname, preferred))
      }
    }
  } catch {
    /* Safari 隐私模式下 sessionStorage 可能抛错：跳过一次性跳转即可。 */
  }
}
