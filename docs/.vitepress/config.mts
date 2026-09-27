/**
 * docs.limooo.cn — VitePress 站点配置
 *
 * 内容源：Flask/docs/*.md
 *   docs/video-platform.md            → /video-platform
 *   docs/video-platform/en-us.md      → /video-platform/en-us
 *   docs/en-us.md                     → /en-us
 *
 * 语言码放在**页面路径最后一段**（不是 VitePress 的 locales 前缀），所以不用
 * `locales`，改用 `additionalConfig`（按**源目录**分层）+ `rewrites`：
 * 每个页面拿到自己那份 lang / themeConfig（导航、侧栏、UI 文案都跟着语言走）。
 *
 * 主题：fork Limooooo-Studio/vitepress —— 页头/页脚在 fork 里改。
 */
import { readFileSync } from 'node:fs'

import { defineConfig } from 'vitepress'
import type { DefaultTheme } from 'vitepress'

import { THEME_BOOTSTRAP_SCRIPT } from './theme/limooo.ts'

const SITE_URL = 'https://docs.limooo.cn'
const MAIN_SITE = 'https://limooo.cn'
const SERVICES_SITE = 'https://services.limooo.cn'
const CONTACT_SITE = 'https://contact.limooo.cn'
const REPO = 'https://github.com/Limooooo-Studio/Limooo-Website'

interface LangDef {
  code: string
  label: string
  flag: string
  lang: string
  default?: boolean
}

const LANGS: LangDef[] = [
  { code: 'zh-cn', label: '简体中文', flag: '🇨🇳', lang: 'zh-CN', default: true },
  { code: 'en-us', label: 'English', flag: '🇺🇸', lang: 'en-US' },
  { code: 'ja-jp', label: '日本語', flag: '🇯🇵', lang: 'ja-JP' },
  { code: 'ko-kr', label: '한국어', flag: '🇰🇷', lang: 'ko-KR' }
]

const CODES = LANGS.map((l) => l.code)
const DEFAULT_LANG = LANGS.find((l) => l.default)?.code ?? CODES[0]

/** 语言码 -> BCP 47 标签（写进 <html lang> 与 head）。 */
function langTag(code: string): string {
  return (LANGS.find((l) => l.code === code) ?? LANGS[0]).lang
}

/** 页面路径 + 语言码 → 该语言的 URL 路径。 */
function routePath(basePath: string, code: string): string {
  const base = basePath === '/' ? '' : basePath
  if (code === DEFAULT_LANG) return base || '/'
  return `${base}/${code}`
}

/** 每个语言一份 UI 文案；VitePress 不会自动翻译默认主题。 */
interface Labels {
  title: string
  description: string
  navHome: string
  navServices: string
  navContact: string
  docsSection: string
  sidebarHome: string
  sidebarVideo: string
  sidebarMain: string
  outlineTitle: string
  sidebarMenuLabel: string
  darkModeSwitchLabel: string
  langMenuLabel: string
  prev: string
  next: string
  footerRights: string
  footerSource: string
}

const labels: Record<string, Labels> = {
  'zh-cn': {
    title: 'Limooo 文档',
    description: 'Limooo 的公开文档：平台清单、隐私与合规参考。',
    navHome: '主页',
    navServices: '服务',
    navContact: '联系方式',
    docsSection: '文档',
    sidebarHome: '文档首页',
    sidebarVideo: '视频平台',
    sidebarMain: '返回主站',
    outlineTitle: '本页目录',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '外观',
    langMenuLabel: '切换语言',
    prev: '上一页',
    next: '下一页',
    footerRights: '保留所有权利',
    footerSource: '源码'
  },
  'en-us': {
    title: 'Limooo Docs',
    description: 'Public Limooo documentation: platform inventories, privacy and compliance references.',
    navHome: 'Home',
    navServices: 'Services',
    navContact: 'Contact',
    docsSection: 'Documentation',
    sidebarHome: 'Docs home',
    sidebarVideo: 'Video platforms',
    sidebarMain: 'Main site',
    outlineTitle: 'On this page',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Appearance',
    langMenuLabel: 'Change language',
    prev: 'Previous page',
    next: 'Next page',
    footerRights: 'All rights reserved',
    footerSource: 'Source'
  },
  'ja-jp': {
    title: 'Limooo ドキュメント',
    description: 'Limooo の公開ドキュメント：プラットフォーム一覧、プライバシーとコンプライアンスの参考資料。',
    navHome: 'ホーム',
    navServices: 'サービス',
    navContact: 'お問い合わせ',
    docsSection: 'ドキュメント',
    sidebarHome: 'ドキュメント ホーム',
    sidebarVideo: '動画プラットフォーム',
    sidebarMain: 'メインサイト',
    outlineTitle: 'このページの目次',
    sidebarMenuLabel: 'メニュー',
    darkModeSwitchLabel: '外観',
    langMenuLabel: '言語を変更',
    prev: '前のページ',
    next: '次のページ',
    footerRights: 'All rights reserved',
    footerSource: 'ソース'
  },
  'ko-kr': {
    title: 'Limooo 문서',
    description: 'Limooo 공개 문서: 플랫폼 목록, 개인정보 및 컴플라이언스 참고 자료.',
    navHome: '홈',
    navServices: '서비스',
    navContact: '문의',
    docsSection: '문서',
    sidebarHome: '문서 홈',
    sidebarVideo: '동영상 플랫폼',
    sidebarMain: '메인 사이트',
    outlineTitle: '이 페이지 목차',
    sidebarMenuLabel: '메뉴',
    darkModeSwitchLabel: '테마',
    langMenuLabel: '언어 변경',
    prev: '이전 페이지',
    next: '다음 페이지',
    footerRights: '모든 권리 보유',
    footerSource: '소스'
  }
}

function themeFor(code: string): DefaultTheme.Config {
  const L = labels[code] ?? labels[DEFAULT_LANG]
  const home = routePath('/', code)
  const video = routePath('/video-platform', code)
  return {
    // 页头/页脚由 fork 的 Limooo 组件渲染（与主站 base.html 一致）
    // 页头就是主站那三个入口（跟 limooo.cn 完全一致），文档自己的导航在侧栏
    nav: [
      { text: L.navHome, link: MAIN_SITE },
      { text: L.navServices, link: SERVICES_SITE },
      { text: L.navContact, link: CONTACT_SITE }
    ],
    sidebar: [
      {
        text: L.docsSection,
        items: [
          { text: L.sidebarHome, link: home },
          { text: L.sidebarVideo, link: video },
          { text: L.sidebarMain, link: MAIN_SITE }
        ]
      }
    ],
    outline: { level: [2, 3], label: L.outlineTitle },
    sidebarMenuLabel: L.sidebarMenuLabel,
    darkModeSwitchLabel: L.darkModeSwitchLabel,
    langMenuLabel: L.langMenuLabel,
    docFooter: { prev: L.prev, next: L.next },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Limooooo-Studio' },
      { icon: 'bilibili', link: 'https://space.bilibili.com/1234163143', ariaLabel: 'Bilibili' }
    ],
    footer: {
      copyright: '© 2026 <span class="footer-brand">Limooo</span> Studio',
      items: [
        { text: L.footerRights },
        { text: 'AGPL-3.0' },
        { text: L.footerSource, link: REPO }
      ]
    },
    limooo: { languages: LANGS }
  } as DefaultTheme.Config
}

/** 每个语言的 lang / 标题 / 主题配置（纯数据，能安全序列化进客户端）。 */
function localeConfigFor(code: string) {
  const L = labels[code] ?? labels[DEFAULT_LANG]
  return {
    lang: langTag(code),
    title: L.title,
    description: L.description,
    themeConfig: themeFor(code)
  }
}

/**
 * 源文件放各自的语言目录（en-us/index.md），用 rewrites 把路由改成
 * 「语言码在最后一段」（/en-us、/video-platform/en-us）。
 * 不用 additionalConfig 的函数形式：函数会被序列化进客户端而丢掉闭包。
 * 映射表同时被 ops/docs_deploy.sh 的产物校验读取，保持单一事实源。
 */
const REWRITES: Record<string, string> = JSON.parse(
  readFileSync(new URL('./rewrites.json', import.meta.url), 'utf-8')
)

export default defineConfig({
  lang: langTag(DEFAULT_LANG),
  title: labels[DEFAULT_LANG].title,
  description: labels[DEFAULT_LANG].description,
  cleanUrls: true,
  metaChunk: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#05A5A6' }],
    ['meta', { name: 'color-scheme', content: 'light dark' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Limooo Docs' }],
    ['meta', { property: 'og:url', content: SITE_URL }],
    [
      'link',
      {
        rel: 'preload',
        href: '/fonts/baloo2-latin-wght-normal.woff2',
        as: 'font',
        type: 'font/woff2',
        crossorigin: ''
      }
    ],
    ['link', { rel: 'stylesheet', href: '/fonts.css' }],
    // 必须在 VitePress 的 check-dark-mode 之前执行：把主站 limooo_theme cookie
    // 灌进 localStorage，避免与主站深浅模式不一致造成的首屏闪烁。
    ['script', { id: 'limooo-theme-bridge' }, THEME_BOOTSTRAP_SCRIPT]
  ],
  sitemap: { hostname: SITE_URL },
  rewrites: REWRITES,
  themeConfig: themeFor(DEFAULT_LANG),
  // 按**源目录**给页面套上对应语言的 lang + themeConfig（纯数据，可序列化）
  additionalConfig: {
    '/': localeConfigFor('zh-cn'),
    '/en-us/': localeConfigFor('en-us'),
    '/ja-jp/': localeConfigFor('ja-jp'),
    '/ko-kr/': localeConfigFor('ko-kr')
  }
})
