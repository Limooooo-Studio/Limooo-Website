/**
 * image-watermark 路由纯函数测试（docs/14，A2 归一化代理）。
 * 运行：node --test ops/image-watermark/src/index.test.js
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import worker, {
  landingRedirect,
  logicalPath,
  routeFor,
  shouldWatermark,
  wmTarget,
} from "./index.js";

const ORIGIN = "https://limooo.cn";

test("logicalPath 去掉 /static 前缀（兼容 images.limooo.cn 风格路径）", () => {
  assert.equal(logicalPath("/portfolio/a.webp"), "/portfolio/a.webp");
  assert.equal(logicalPath("/static/portfolio/a.webp"), "/portfolio/a.webp");
  assert.equal(logicalPath("/static/qr-codes/a.png"), "/qr-codes/a.png");
});

test("裸域跳转到可索引的图片门面页，其余资源路径不跳转", () => {
  assert.equal(
    landingRedirect(new URL("https://image.limooo.cn/")),
    "https://images.limooo.cn/",
  );
  assert.equal(
    landingRedirect(new URL("https://image.limooo.cn/portfolio/a.webp")),
    "",
  );
});

test("Worker 对裸域请求返回永久跳转", async () => {
  const response = await worker.fetch(
    new Request("https://image.limooo.cn/"),
    {},
    { waitUntil() {} },
  );
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "https://images.limooo.cn/");
});

test("只有作品集根目录下的 png/jpg/jpeg/webp 加水印，thumbs 不算", () => {
  assert.equal(shouldWatermark("/portfolio/a.webp"), true);
  assert.equal(shouldWatermark("/portfolio/a.jpg"), true);
  assert.equal(shouldWatermark("/portfolio/a.png"), true);
  assert.equal(shouldWatermark("/portfolio/thumbs/a.webp"), false);
  assert.equal(shouldWatermark("/qr-codes/a.png"), false);
  assert.equal(shouldWatermark("/icons/a.png"), false);
});

test("作品集根目录图片永远返回水印变体（无论来源）", () => {
  const url = new URL("https://image.limooo.cn/portfolio/a.webp");
  const route = routeFor(url, { headers: new Headers() }, ORIGIN);
  assert.equal(route.watermarked, true);
  assert.ok(route.target.startsWith(`${ORIGIN}/static/wm/portfolio/a.webp`));
  assert.ok(route.target.includes("__wmver="));
});

test("thumbs / qr-codes / icons 走干净静态版，不加水印", () => {
  const thumb = routeFor(new URL("https://image.limooo.cn/portfolio/thumbs/a.webp"), { headers: new Headers() }, ORIGIN);
  assert.equal(thumb.watermarked, false);
  assert.equal(thumb.target, `${ORIGIN}/static/portfolio/thumbs/a.webp`);

  const qr = routeFor(new URL("https://image.limooo.cn/qr-codes/a.png"), { headers: new Headers() }, ORIGIN);
  assert.equal(qr.watermarked, false);
  assert.equal(qr.target, `${ORIGIN}/static/qr-codes/a.png`);

  const icon = routeFor(new URL("https://image.limooo.cn/icons/Limooo.svg"), { headers: new Headers() }, ORIGIN);
  assert.equal(icon.watermarked, false);
  assert.equal(icon.target, `${ORIGIN}/static/icons/Limooo.svg`);
});

test("兼容 /static 前缀：/static/portfolio/a.webp 同样返回水印", () => {
  const route = routeFor(new URL("https://images.limooo.cn/static/portfolio/a.webp"), { headers: new Headers() }, ORIGIN);
  assert.equal(route.watermarked, true);
  assert.ok(route.target.startsWith(`${ORIGIN}/static/wm/portfolio/a.webp`));
});

test("绝不代理 /api/* 与未知路径", () => {
  const api = routeFor(new URL("https://image.limooo.cn/api/secret?q=1"), { headers: new Headers() }, ORIGIN);
  assert.equal(api.target, "");
  assert.equal(api.image, false);

  const unknown = routeFor(new URL("https://image.limooo.cn/random/thing"), { headers: new Headers() }, ORIGIN);
  assert.equal(unknown.target, "");
});

test("水印回源 URL 访问 /static/wm/ 并带版本参数", () => {
  const target = wmTarget(ORIGIN, "/portfolio/a.webp", "?v=1");
  assert.equal(new URL(target).pathname, "/static/wm/portfolio/a.webp");
  assert.ok(target.includes("__wmver=3"));
});
