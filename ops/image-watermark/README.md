# image-watermark

`image.limooo.cn/*` 的 Cloudflare Worker：按 Referer 给图片返回原图或 Limooo 水印图。

## 行为

- 图片请求从 `limooo.cn/static/<path>`（原图）或 `limooo.cn/static/wm/<path>`（水印变体）取图，
  与 `images.limooo.cn` 的路径规则一致（不回源到 `image.limooo.cn` 自身，避免循环）。
- Referer 主机为 `limooo.cn` 或 `*.limooo.cn` → 返回无水印原图。
- 无 Referer 或来自其他站点 → 返回水印变体（左下角叠加，水印宽度约为图片短边的 25%，下限 96px，
  透明度约 72% 并带深色半透明底衬）；**只对 `portfolio/` 下的 png/jpg/jpeg/webp 加水印**。
- 非图片请求透传 `limooo.cn` 响应，不做任何处理。
- `icons/`、`qr-codes/` 等非 portfolio 路径，以及 gif/avif/svg/ico 等格式，原样透传不加印。

## 架构说明

Watermark 变体不在 Worker 里实时合成（Workers Free 套餐单次 CPU 10ms，
且运行时没有 Canvas/图片重编码 API，Image Resizing 为付费功能），
而是由 `src/build.py` 在构建时用 Pillow 生成到 `public/static/wm/`，
随 Cloudflare Pages 一起部署。Worker 只做按 Referer 的路由选择，CPU 开销接近零。

目前只给 `portfolio/`（作品集照片）加水印：`qr-codes/`（二维码被遮挡无法扫描）、
`icons/`（品牌 logo/favicon）等都不加。

## 缓存策略

- 浏览器/边缘侧：`Cache-Control: public, max-age=86400, s-maxage=86400`，
  配合 `Vary: Referer` 让两种变体按来源分别缓存，避免串发。
- Worker 侧：按回源 URL（原图/水印变体是不同 URL）写入 Cache API（`public, max-age=86400`），
  互不污染，回源最多每天一次。

## 部署

```bash
cd Flask/ops/image-watermark
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy
```

路由与 DNS（`image.limooo.cn` CNAME → `limooo.pages.dev`，proxied）：
`image.limooo.cn/*` → `image-watermark`。

Token 从服务器 `secrets/webauthn.env` 读取（与 Pages 部署同一份凭据），不写入仓库。
部署水印变体前需先跑一次 `bash ops/pages_deploy.sh`（build.py 会生成 `public/static/wm/`）。

## 调整水印外观后的上线步骤

水印的尺寸/透明度/底衬参数在 `src/build.py` 的 `generate_watermarks()` 顶部常量里。
改完外观后：

1. `bash ops/pages_deploy.sh`（重新生成并部署水印变体）
2. `src/index.js` 里 `WM_VERSION` +1（绕过 CDN 旧缓存），再 `npx wrangler deploy`
