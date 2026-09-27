/**
 * docs.limooo.cn — VitePress 站点配置
 *
 * 内容源：Flask/docs/*.md（每个 md 对应 docs.limooo.cn/<文件名>）
 * 主题实现：消费 Limooooo-Studio/vitepress fork（页头/页脚在 fork 里改）
 *
 * 语言：root = zh-cn，另有 en-us / ja-jp / ko-kr 三个目录前缀，
 * 前缀名与主站 config-contract.json 的 supported_langs 完全一致，
 * 这样 user_lang_preference cookie 的值可以直接当 URL 前缀用。
 */
import { defineConfig } from 'vitepress'
import type { DefaultTheme } from 'vitepress'

import { THEME_BOOTSTRAP_SCRIPT } from './theme/limooo.ts'

const SITE_URL = 'https://docs.limooo.cn'
const MAIN_SITE = 'https://limooo.cn'
const REPO = 'https://github.com/Limooooo-Studio/Limooo-Website'

/** 每个语言一份 UI 文案；VitePress 不会自动翻译默认主题。 */
interface Labels {
  title: string
  description: string
  navVideo: string
  navHome: string
  navMain: string
  outlineTitle: string
  lastUpdatedText: string
  returnToTopLabel: string
  sidebarMenuLabel: string
  darkModeSwitchLabel: string
  lightModeSwitchTitle: string
  darkModeSwitchTitle: string
  langMenuLabel: string
  prev: string
  next: string
  footerMessage: string
  footerCopyright: string
}

const labels: Record<string, Labels> = {
  root: {
    title: 'Limooo 文档',
    description: 'Limooo 的公开文档：平台清单、隐私与合规参考。',
    navVideo: '视频平台',
    navHome: '文档首页',
    navMain: '返回主站',
    outlineTitle: '本页目录',
    lastUpdatedText: '最后更新',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    langMenuLabel: '切换语言',
    prev: '上一页',
    next: '下一页',
    footerMessage: '文档以 CC BY 4.0 提供，仅供参考，不构成法律意见。',
    footerCopyright: '© 2026 Limooo'
  },
  'en-us': {
    title: 'Limooo Docs',
    description: 'Public Limooo documentation: platform inventories, privacy and compliance references.',
    navVideo: 'Video Platforms',
    navHome: 'Docs Home',
    navMain: 'Main site',
    outlineTitle: 'On this page',
    lastUpdatedText: 'Last updated',
    returnToTopLabel: 'Return to top',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Appearance',
    lightModeSwitchTitle: 'Switch to light theme',
    darkModeSwitchTitle: 'Switch to dark theme',
    langMenuLabel: 'Change language',
    prev: 'Previous page',
    next: 'Next page',
    footerMessage: 'Documentation provided under CC BY 4.0 for reference only; not legal advice.',
    footerCopyright: '© 2026 Limooo'
  },
  'ja-jp': {
    title: 'Limooo ドキュメント',
    description: 'Limooo の公開ドキュメント：プラットフォーム一覧、プライバシーとコンプライアンスの参考資料。',
    navVideo: '動画プラットフォーム',
    navHome: 'ドキュメント',
    navMain: 'メインサイト',
    outlineTitle: 'このページの目次',
    lastUpdatedText: '最終更新',
    returnToTopLabel: 'トップへ戻る',
    sidebarMenuLabel: 'メニュー',
    darkModeSwitchLabel: '外観',
    lightModeSwitchTitle: 'ライトテーマに切り替え',
    darkModeSwitchTitle: 'ダークテーマに切り替え',
    langMenuLabel: '言語を変更',
    prev: '前のページ',
    next: '次のページ',
    footerMessage: '本ドキュメントは CC BY 4.0 で提供され、参考情報であり法的助言ではありません。',
    footerCopyright: '© 2026 Limooo'
  },
  'ko-kr': {
    title: 'Limooo 문서',
    description: 'Limooo 공개 문서: 플랫폼 목록, 개인정보 및 컴플라이언스 참고 자료.',
    navVideo: '동영상 플랫폼',
    navHome: '문서 홈',
    navMain: '메인 사이트',
    outlineTitle: '이 페이지 목차',
    lastUpdatedText: '최종 수정',
    returnToTopLabel: '맨 위로',
    sidebarMenuLabel: '메뉴',
    darkModeSwitchLabel: '테마',
    lightModeSwitchTitle: '라이트 테마로 전환',
    darkModeSwitchTitle: '다크 테마로 전환',
    langMenuLabel: '언어 변경',
    prev: '이전 페이지',
    next: '다음 페이지',
    footerMessage: '이 문서는 CC BY 4.0으로 제공되며 참고용일 뿐 법률 자문이 아닙니다.',
    footerCopyright: '© 2026 Limooo'
  }
}

/** 非 root 语言在 URL 里的前缀，同时也是 user_lang_preference 的取值。 */
const NON_ROOT = ['en-us', 'ja-jp', 'ko-kr'] as const
const ROOT_LANG = 'zh-cn'

function prefixOf(localeKey: string): string {
  return localeKey === 'root' ? '' : `/${localeKey}`
}

function themeFor(localeKey: string): DefaultTheme.Config {
  const L = labels[localeKey]
  const p = prefixOf(localeKey)
  return {
    logo: { src: '/logo.svg', width: 24, height: 24, alt: 'Limooo' },
    nav: [
      { text: L.navHome, link: `${p}/` },
      { text: L.navVideo, link: `${p}/video-platform` },
      { text: L.navMain, link: MAIN_SITE }
    ],
    sidebar: {
      [`${p}/`]: [
        {
          text: L.navHome,
          items: [
            { text: L.navHome, link: `${p}/` },
            { text: L.navVideo, link: `${p}/video-platform` }
          ]
        }
      ]
    },
    outline: { level: [2, 3], label: L.outlineTitle },
    lastUpdated: { text: L.lastUpdatedText },
    returnToTopLabel: L.returnToTopLabel,
    sidebarMenuLabel: L.sidebarMenuLabel,
    darkModeSwitchLabel: L.darkModeSwitchLabel,
    lightModeSwitchTitle: L.lightModeSwitchTitle,
    darkModeSwitchTitle: L.darkModeSwitchTitle,
    langMenuLabel: L.langMenuLabel,
    docFooter: { prev: L.prev, next: L.next },
    footer: { message: L.footerMessage, copyright: L.footerCopyright },
    editLink: {
      pattern: `${REPO}/edit/main/Flask/docs/:path`,
      text: localeKey === 'root' ? '在 GitHub 上编辑此页' : 'Edit this page on GitHub'
    },
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' }
  }
}

export default defineConfig({
  lang: 'zh-CN',
  title: labels.root.title,
  description: labels.root.description,
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
    // 必须在 VitePress 的 check-dark-mode 之前执行：把主站 limooo_theme cookie
    // 灌进 localStorage，避免与主站深浅模式不一致造成的首屏闪烁。
    ['script', { id: 'limooo-theme-bridge' }, THEME_BOOTSTRAP_SCRIPT]
  ],
  sitemap: { hostname: SITE_URL },
  themeConfig: themeFor('root'),
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: labels.root.title,
      description: labels.root.description,
      themeConfig: themeFor('root')
    },
    ...Object.fromEntries(
      NON_ROOT.map((key) => [
        key,
        {
          label: key === 'en-us' ? 'English' : key === 'ja-jp' ? '日本語' : '한국어',
          lang: key === 'en-us' ? 'en-US' : key === 'ja-jp' ? 'ja-JP' : 'ko-KR',
          link: `/${key}/`,
          title: labels[key].title,
          description: labels[key].description,
          themeConfig: themeFor(key)
        }
      ])
    )
  }
})

export { ROOT_LANG, NON_ROOT }
