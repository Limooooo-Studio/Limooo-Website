/**
 * image-watermark 路由纯函数测试（docs/14）。
 * 运行：node --test ops/image-watermark/src/index.test.js
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { refererAllowed, routeFor, shouldWatermark, wmTarget } from "./index.js";

const ORIGIN = "https://limooo.cn";

function request(referer) {
  const headers = new Headers();
  if (referer) headers.set("Referer", referer);
  return { headers };
}

test("只给 portfolio 下的 png/jpg/jpeg/webp 加水印", () => {
  assert.equal(shouldWatermark("/portfolio/a.webp"), true);
  assert.equal(shouldWatermark("/portfolio/a.jpg"), true);
  assert.equal(shouldWatermark("/portfolio/a.png"), true);
  assert.equal(shouldWatermark("/portfolio/a.gif"), false);
  assert.equal(shouldWatermark("/qr-codes/a.png"), false);
  assert.equal(shouldWatermark("/icons/a.png"), false);
});

test("Referer 白名单精确匹配 limooo.cn 家族", () => {
  assert.equal(refererAllowed("https://limooo.cn/"), true);
  assert.equal(refererAllowed("https://services.limooo.cn/"), true);
  assert.equal(refererAllowed("https://image.limooo.cn/a"), true);
  assert.equal(refererAllowed("https://limooo.cn.evil.example/"), false);
  assert.equal(refererAllowed("https://evil.example/"), false);
  assert.equal(refererAllowed(""), false);
});

test("站内 Referer 返回原图，站外返回水印变体", () => {
  const url = new URL("https://image.limooo.cn/portfolio/a.webp");
  assert.equal(
    routeFor(url, request("https://limooo.cn/"), ORIGIN).watermarked,
    false,
  );
  assert.equal(
    routeFor(url, request("https://evil.example/"), ORIGIN).watermarked,
    true,
  );
  assert.equal(routeFor(url, request(null), ORIGIN).watermarked, true);
});

test("非图片请求只允许已知资源目录，杜绝任意 /api/* 代理", () => {
  const url = new URL("https://image.limooo.cn/api/secret?q=1");
  const route = routeFor(url, request(null), ORIGIN);
  assert.equal(route.image, false);
  assert.equal(route.target, "");

  const knownUrl = new URL("https://image.limooo.cn/portfolio/index.html");
  const known = routeFor(knownUrl, request(null), ORIGIN);
  assert.equal(known.image, false);
  assert.equal(known.target, `${ORIGIN}/portfolio/index.html`);
});

test("水印回源 URL 只访问 /static/wm/ 并带版本参数", () => {
  const url = new URL("https://image.limooo.cn/portfolio/a.webp?v=1");
  const target = wmTarget(ORIGIN, url);
  assert.equal(new URL(target).pathname, "/static/wm/portfolio/a.webp");
  assert.ok(target.includes("__wmver=3"));
});
