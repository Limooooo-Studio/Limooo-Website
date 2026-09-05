# image-watermark

`image.limooo.cn/*` 的 Cloudflare Worker：**A2 归一化代理**——把 `image.limooo.cn` 收到的
请求按「逻辑路径」回源到公开静态资源，永远返回水印或干净版。

## 背景（A2）

作品集完整原图（`src/static/portfolio/*`）**不再对外发布**。公开 Pages bundle 里：

- `/static/wm/portfolio/*` ：水印全图（由 `src/build.py` 用 Pillow 预生成）。
- `/static/portfolio/thumbs/*` ：干净缩略图（仅首页卡片用）。
- `/static/qr-codes/*`、`/static/icons/*` ：干净资源。
- 原图 `/static/portfolio/<图>` 已从 bundle 移除，访问会 404。

因此 Worker **不再按 Referer 区分原图/水印**（原图已不存在于任何公开地址），
也就没有可被伪造 Referer 绕过的口子。

## 行为

- `/portfolio/<图>.webp|jpg|jpeg|png`（不在 `thumbs/` 子目录）→ **永远**返回水印变体
  `/static/wm/portfolio/<图>`（无论来源）。
- `/portfolio/thumbs/*`、`/qr-codes/*`、`/icons/*` → 返回干净静态版 `/static/<路径>`。
- 兼容 `images.limooo.cn` 风格的 `/static/portfolio/...`：会自动去掉 `/static` 前缀再归一化。
- 绝不代理 `/api/*`；非图片、非已知目录 → 404。
- 水印变体缺失时直接 404，**不回退原图**（避免旧缓存里的干净原图被误当成回源）。

## 架构说明

水印变体不在 Worker 里实时合成（Workers Free 套餐单次 CPU 10ms，
且运行时没有 Canvas/图片重编码 API，Image Resizing 为付费功能），
而是由 `src/build.py` 构建时用 Pillow 生成到 `public/static/wm/portfolio/`，
随 Cloudflare Pages 一起部署。Worker 只做路径归一化与代理，CPU 开销接近零。

只给 `portfolio/`（作品集照片）加水印：`qr-codes/`（二维码被遮挡无法扫描）、
`icons/`（品牌 logo/favicon）等都不加。

## 缓存策略

- 浏览器/边缘侧：`Cache-Control: public, max-age=86400, s-maxage=86400`。
  A2 下同一 URL 对所有来源返回同一份，**不加 `Vary: Referer`**。
- Worker 侧：按回源 URL（水印/干净版是不同的 URL）写入 Cache API（`public, max-age=86400`），
  互不污染，回源最多每天一次。

## 部署

```bash
# 1) 重新构建并部署 Pages（会重新生成 public/static/wm/ 并清掉原图）
bash ops/pages_deploy.sh

# 2) 部署 Worker（更新 image.limooo.cn 路由逻辑）
bash ops/workers_deploy.sh --worker=image-watermark
```

路由与 DNS（`image.limooo.cn` CNAME → `limooo.pages.dev`，proxied）：
`image.limooo.cn/*` → `image-watermark`（路由在 Cloudflare 控制台管理）。

Token 从服务器 `secrets/webauthn.env` 读取（与 Pages 部署同一份凭据），不写入仓库。

## 调整水印外观后的上线步骤

水印尺寸/透明度/底衬参数在 `src/build.py` 的 `generate_watermarks()` 顶部常量里。
改完外观后：

1. `bash ops/pages_deploy.sh`（重新生成并部署水印变体）
2. `src/index.js` 里 `WM_VERSION` +1（绕过 CDN 旧缓存），再 `bash ops/workers_deploy.sh --worker=image-watermark`

## 原图备份

原图只在本地 `src/static/portfolio/` 与私有 R2 桶（`limooo-originals`）中留存。
备份：`bash ops/upload_originals.sh`（首次会创建私有桶）。
