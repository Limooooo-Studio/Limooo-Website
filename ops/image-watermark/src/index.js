/**
 * image-watermark —— image.limooo.cn 图片水印 Worker（纯路由）
 *
 * 规则：
 *  1. 图片请求（/portfolio/*、/qr-codes/*、/icons/* 等）从 limooo.cn 取原图，
 *     路径映射为 /static 前缀（与 images.limooo.cn 的规则一致），
 *     绝不回源到 image.limooo.cn 自身，避免循环。
 *  2. Referer 主机为 limooo.cn 或 *.limooo.cn → 返回无水印原图
 *     （limooo.cn/static/<path>）；
 *     无 Referer 或来自其他站点 → 返回水印变体（limooo.cn/static/wm/<path>，
 *     由 src/build.py 构建时用 Pillow 预先生成）。
 *  3. 非图片请求直接透传 limooo.cn 的响应，不做任何处理。
 *  4. 缓存：浏览器侧 private（共享缓存不缓存，因为响应依赖 Referer），
 *     Worker 内按「回源 URL」走 Cache API，原图与水印变体是不同 URL，
 *     天然互不污染。
 */

const ORIGIN = "https://limooo.cn";

// 站点上实际使用的图片扩展名（与 images.limooo.cn 暴露的内容一致）
const IMAGE_PATH_RE = /\.(png|jpe?g|webp|avif|gif|bmp|ico)$/i;

// 浏览器缓存 1 天；private 确保共享缓存不会把两种变体混发
const CLIENT_CACHE = "private, max-age=86400";

// 水印变体版本号：改了水印外观（src/build.py 的生成参数）后 +1，
// 让 Worker 用新的回源 URL 绕过 CDN/本地缓存里的旧版水印图
const WM_VERSION = "3";

/**
 * 是否应该使用水印变体（与 build.py generate_watermarks 的排除规则一致）：
 * 只给 /portfolio/ 下的 png/jpg/jpeg/webp 加水印；
 * 其他路径（icons、qr-codes 等）一律返回原图。
 */
export function shouldWatermark(pathname) {
  if (!pathname.startsWith("/portfolio/")) return false;
  return /\.(png|jpe?g|webp)$/i.test(pathname);
}

/** Referer 是否来自 limooo.cn 家族（主机名精确匹配，防 limooo.cn.evil.com 绕过） */
export function refererAllowed(referer) {
  if (!referer) return false;
  try {
    const host = new URL(referer).hostname.toLowerCase();
    return host === "limooo.cn" || host.endsWith(".limooo.cn");
  } catch {
    return false;
  }
}

/**
 * 决定图片/非图片请求的回源目标。
 * 返回 { target, originalUrl?, watermarked, image }；watermarked 时若 target 404，
 * 由调用方回退 originalUrl。
 */
export function routeFor(url, request, origin) {
  if (!IMAGE_PATH_RE.test(url.pathname)) {
    // 非图片：只允许已知资源目录，且绝不放行 /api/*
    const allowed = /^\/(?:portfolio|qr-codes|icons)(?:\/|$)/.test(url.pathname);
    return {
      target: allowed ? origin + url.pathname + url.search : "",
      watermarked: false,
      image: false,
    };
  }
  const originalUrl = origin + "/static" + url.pathname + url.search;
  if (refererAllowed(request.headers.get("Referer")) || !shouldWatermark(url.pathname)) {
    return { target: originalUrl, originalUrl, watermarked: false, image: true };
  }
  return {
    target: wmTarget(origin, url),
    originalUrl,
    watermarked: true,
    image: true,
  };
}

/** 构造水印变体回源 URL（带版本参数，缓存破坏用） */
export function wmTarget(origin, url) {
  const u = new URL(origin + "/static/wm" + url.pathname + url.search);
  u.searchParams.set("__wmver", WM_VERSION);
  return u.toString();
}

/** 组装发给客户端（浏览器）的响应：private 缓存 + 必要的安全/调试头 */
function clientResponse(store, watermarked) {
  const headers = new Headers({
    "Content-Type": store.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": CLIENT_CACHE,
    "Vary": "Referer",
    "Access-Control-Allow-Origin": "*",
    "X-Limooo-Watermark": watermarked ? "1" : "0",
  });
  const etag = store.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  return new Response(store.body, { status: store.status, headers });
}

/** HEAD 请求：与 GET 相同的路由决策，只返回头部 */
async function headResponse(request, origin, ctx) {
  const url = new URL(request.url);
  const route = routeFor(url, request, origin);
  let resp = await fetch(route.target, { method: "HEAD" });
  if (route.watermarked && resp.status === 404) {
    resp = await fetch(route.originalUrl, { method: "HEAD" });
  }
  const headers = new Headers({
    "Content-Type": resp.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": CLIENT_CACHE,
    "Vary": "Referer",
    "X-Limooo-Watermark": route.watermarked && resp.status !== 404 ? "1" : "0",
  });
  return new Response(null, { status: resp.status, headers });
}

/**
 * 回源 limooo.cn 并缓存：Cache API key 用回源 URL（与客户端 URL 不同，
 * 因此共享缓存不会把原图/水印两种变体串发）。
 */
async function proxyAndCache(request, originUrl, ctx, watermarked) {
  const cacheRequest = new Request(originUrl, { method: "GET" });
  const cached = await caches.default.match(cacheRequest);
  if (cached) return clientResponse(cached, watermarked);

  const originResp = await fetch(originUrl, {
    headers: { Accept: request.headers.get("Accept") || "*/*" },
  });
  if (!originResp.ok) {
    // 404/5xx 等原样透传（水印变体缺失时由调用方决定是否回退原图）
    return new Response(originResp.body, originResp);
  }

  const buf = await originResp.arrayBuffer();
  const store = new Response(buf, {
    status: originResp.status,
    headers: {
      "Content-Type": originResp.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "ETag": originResp.headers.get("ETag") || "",
      "Last-Modified": originResp.headers.get("Last-Modified") || "",
    },
  });
  ctx.waitUntil(caches.default.put(cacheRequest, store.clone()));
  return clientResponse(store, watermarked);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 默认回源 limooo.cn；本地调试可用 ORIGIN 环境变量指向本地静态服务器
    const origin = env.ORIGIN || ORIGIN;

    // HEAD：与 GET 相同的 Referer 路由决策，只回头部
    if (request.method === "HEAD") {
      return headResponse(request, origin, ctx);
    }
    // 其他非 GET 方法直接透传
    if (request.method !== "GET") {
      return fetch(origin + url.pathname + url.search, { method: request.method });
    }

    // 非图片请求直接放行：原样透传 limooo.cn 响应
    const route = routeFor(url, request, origin);
    if (!route.image) {
      if (!route.target) return new Response("Not Found", { status: 404 });
      return fetch(route.target);
    }
    if (!route.watermarked) {
      return proxyAndCache(request, route.target, ctx, false);
    }

    // 无 Referer / 非 limooo.cn 来源 → 水印变体；404（未重新构建）→ 回退原图
    {
      const resp = await proxyAndCache(request, route.target, ctx, true);
      if (resp.status !== 404) return resp;
      return proxyAndCache(request, route.originalUrl, ctx, false);
    }
  },
};
