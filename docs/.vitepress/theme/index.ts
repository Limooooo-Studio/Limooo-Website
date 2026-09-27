/**
 * docs.limooo.cn 主题入口。
 *
 * 继承 fork 的默认主题（页头/页脚改在 Limooooo-Studio/vitepress 里），
 * 这里只叠加 Limooo 品牌样式与主站 cookie 桥接。
 */
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'

import './styles.css'
import { installCookieBridge } from './limooo'

const theme = {
  extends: DefaultTheme,
  enhanceApp(ctx: Parameters<NonNullable<Theme['enhanceApp']>>[0]) {
    DefaultTheme.enhanceApp?.(ctx)
    installCookieBridge(ctx.router)
  }
} satisfies Theme

export default theme
