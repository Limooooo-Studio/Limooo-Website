/**
 * Limooo Pages 中间件编排层。
 *
 * 本文件只负责请求编排、统一安全头和埋点时机；路由/门禁/跳转/封禁逻辑分别
 * 位于 _lib/routing.ts、_lib/gate.ts、_lib/redirect.ts、_lib/tracking.ts。
 */

import { logEvent } from "./_lib/logging";
import { configErrorResponse, requireAuth, runtimeConfigError } from "./_lib/session";
import { SECURITY_HEADERS } from "./_lib/security";
import {
  detectLang,
  getCookie,
  isGateTrustedIp,
  isApiPath,
  isPublicAssetPath,
  pageAsset,
  preserveSetCookie,
  safeNextPath,
  sanitizeHost,
  viaRedirect,
  withLangCookie,
  type RequestContext,
} from "./_lib/routing";
import {
  APPLEID_HOSTNAME,
  BASE_URL,
  GATE_COOKIE,
  IMAGES_HOSTNAME,
  LANG_COOKIE,
  VISITOR_HOSTNAME,
  WWW_HOSTNAME,
} from "./_lib/config";
import {
  handleGateConfig,
  handleGateDiag,
  handleVerify,
  isBlocked,
  isValidGateCookie,
  mintGateCookie,
  renderGatePage,
} from "./_lib/gate";
import { isRedirectHost, renderRedirectPage } from "./_lib/redirect";
import {
  isTrustedCrawler,
  recordRay,
  recordVisit,
  shouldTrackRay,
  shouldTrackVisit,
} from "./_lib/tracking";

type PagesFunction = (context: RequestContext) => Promise<Response>;

/** 非业务日志必须在响应返回后写入，不能阻塞页面/跳转。 */
function defer(context: RequestContext, promise: Promise<unknown>): void {
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
  } else {
    void promise;
  }
}

/** 公开预渲染页面的边缘缓存策略。 */
const PAGE_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=3600";
const PAGE_CACHE_VARY = "Accept-Language";

type CacheLike = {
  match(request: RequestInfo): Promise<Response | undefined>;
  put(request: RequestInfo, response: Response): Promise<void>;
};

/** 按语言缓存预渲染页面，避免每次请求都重复读取 ASSETS。 */
async function cachedPageAsset(
  context: RequestContext,
  assetPath: string,
  lang: string,
): Promise<Response | null> {
  const { env, request } = context;
  if (!env.ASSETS) return null;

  const cacheUrl = new URL(assetPath, BASE_URL);
  cacheUrl.searchParams.set("__cache", "1");
  cacheUrl.searchParams.set("lang", lang);
  const cache = typeof caches !== "undefined"
    ? (caches as unknown as { default?: CacheLike }).default
    : undefined;

  if (cache) {
    const hit = await cache.match(new Request(cacheUrl));
    if (hit) return hit;
  }

  const asset = await env.ASSETS.fetch(new URL(assetPath, BASE_URL));
  if (!asset.ok) return asset;

  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", PAGE_CACHE_CONTROL);
  headers.set("Vary", PAGE_CACHE_VARY);
  const response = new Response(await asset.arrayBuffer(), {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });

  // 首次访问还没有语言 cookie 时会补 Set-Cookie，因此只缓存后续请求。
  if (cache && getCookie(LANG_COOKIE, request.headers.get("Cookie"))) {
    const put = cache.put(new Request(cacheUrl), response.clone());
    context.waitUntil?.(put);
    if (!context.waitUntil) void put;
  }
  return response;
}

/** 统一注入安全响应头；API 只加 nosniff，避免破坏 JSON 接口。 */
export function withSecurityHeaders(request: Request, resp: Response): Response {
  const headers = new Headers(resp.headers);
  preserveSetCookie(headers, resp.headers);
  const isApi = new URL(request.url).pathname.startsWith("/api/");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (isApi && name !== "X-Content-Type-Options") continue;
    headers.set(name, value);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

async function adminAuthRedirect(
  env: RequestContext["env"],
  request: Request,
  hostname: string,
): Promise<Response | null> {
  if (hostname !== VISITOR_HOSTNAME && hostname !== APPLEID_HOSTNAME) return null;
  try {
    if (await requireAuth(env, request)) return null;
    const url = new URL(request.url);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/login?next=${encodeURIComponent(`https://${hostname}${url.pathname}${url.search}`)}`,
      },
    });
  } catch {
    return Response.json(
      { error: "auth_sessions_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** 构造强制门禁跳转（供快速切换主题时使用，忽略 WAF/白名单/已验证状态）。 */
function forceGateRedirect(
  request: Request,
  hostname: string,
  pathname: string,
  search: string,
): Response {
  // 同域名挑战：在请求来源主机上渲染门禁，而不是跳去 auth.<root_domain>。
  const gateUrl = new URL("/__gate", `https://${hostname}/`);
  const nextUrl = new URL(pathname + search, BASE_URL);
  nextUrl.searchParams.delete("challenge");
  gateUrl.searchParams.set("host", hostname);
  gateUrl.searchParams.set("next", nextUrl.pathname + nextUrl.search);
  gateUrl.searchParams.set("challenge", "1");
  return withLangCookie(request, new Response(null, {
    status: 302,
    headers: {
      Location: gateUrl.toString(),
      "Cache-Control": "no-store",
    },
  }));
}

/** 中间件核心编排，导出供本地测试 mock 依赖。 */
export async function handleOnRequest(context: RequestContext): Promise<Response> {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const configError = runtimeConfigError(env);
  if (configError) return configErrorResponse(configError);
  const { hostname, pathname } = url;
  const forceChallenge = url.searchParams.get("challenge") === "1";

  // 运维健康端点：不记录访客、不经过人机门禁，供 Uptime Kuma 以探针 UA 访问。
  if (pathname === "/_health") {
    return new Response("ok\n", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // 公开静态资源与 API 必须先放行：跳转子域也共享 /static 资源，
  // 不能把 redirect.limooo.cn/static/css/... 也渲染成 Redirecting HTML。
  if (isPublicAssetPath(pathname) || isApiPath(pathname)) return next();

  // 跳转子域：纯中转页，豁免人机验证。
  if (isRedirectHost(hostname)) return renderRedirectPage(context);

  // 门禁接口与公开静态/API 路径不能被门禁拦截。
  if (pathname === "/__gate/verify") return handleVerify(context);
  if (pathname === "/__gate/config") return handleGateConfig(context);
  if (pathname === "/__gate/diag") return handleGateDiag(context);
  // authentik backchannel logout 是服务端回调用，不能被人机门禁重定向。
  if (pathname === "/logout/backchannel") return next();

  // 门禁页：任意主机（对应域名）都能渲染/回跳，做到同域名完成 challenge。
  if (pathname === "/__gate") {
    const gateIp = request.headers.get("CF-Connecting-IP") ?? "";
    const gateWhitelisted = isGateTrustedIp(gateIp);
    const gateCrawler = isTrustedCrawler(request);
    const gateCookie = getCookie(GATE_COOKIE, request.headers.get("Cookie"));
    const gateValid = gateCookie
      ? await isValidGateCookie(gateCookie, env.GATE_HMAC_KEY)
      : false;
    const passed = gateWhitelisted || gateCrawler || gateValid;

    // 已验证：仍在门禁页则送回原主机原路径（不再跳回 auth 中转）。
    if (passed && !forceChallenge) {
      const back = safeNextPath(url.searchParams.get("next") ?? "/");
      const host = sanitizeHost(url.searchParams.get("host"));
      let resp = Response.redirect(viaRedirect(host, back), 302);
      if (!gateValid) {
        const headers = new Headers(resp.headers);
        headers.append("Set-Cookie", await mintGateCookie(env.GATE_HMAC_KEY));
        resp = new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
      return withLangCookie(request, resp);
    }

    // 未验证 / 强制挑战：在对应域名渲染门禁页。
    return renderGatePage(context, {
      host: url.searchParams.get("host") ?? undefined,
      next: url.searchParams.get("next") ?? "/",
    });
  }

  // 图片子域的门面页同样走主站主题切换逻辑；强制挑战直接去同域名 /__gate。
  if (forceChallenge && hostname === IMAGES_HOSTNAME) {
    return forceGateRedirect(request, hostname, pathname, url.search);
  }

  // images.<root_domain>：图片子域公开访问；页面路径吐门面页，其余映射 /static。
  if (hostname === IMAGES_HOSTNAME) {
    const lang = detectLang(request);
    const page = pageAsset(hostname, pathname, lang);
    if (page) {
      const resp = await cachedPageAsset(context, page, lang);
      if (resp?.ok) {
        return withLangCookie(request, resp);
      }
    }
    if (env.ASSETS) {
      const staticAsset = await env.ASSETS.fetch(new URL(`/static${pathname}`, BASE_URL));
      if (staticAsset.ok) {
        return new Response(staticAsset.body, {
          headers: {
            "Content-Type": staticAsset.headers.get("Content-Type") ?? "",
            "Cache-Control": "public, max-age=2592000",
            "ETag": staticAsset.headers.get("ETag") ?? "",
          },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  // www 保持原 nginx 行为：先 301 到主站（保留路径）。
  if (hostname === WWW_HOSTNAME) {
    return withLangCookie(request, new Response(null, {
      status: 301,
      headers: {
        Location: `${BASE_URL}${pathname}${url.search}`,
        "Cache-Control": "no-store",
      },
    }));
  }

  // 应用层封禁（放行登录/管理路径，避免管理员从被封 IP 无法登录）。
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const whitelisted = isGateTrustedIp(ip);
  const trustedCrawler = isTrustedCrawler(request);
  const exempt =
    pathname.startsWith("/login") ||
    pathname.startsWith("/logout") ||
    pathname.startsWith("/appleid") ||
    pathname.startsWith("/visitor") ||
    pathname.startsWith("/api/appleid") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/ray");
  if (!whitelisted && !exempt && ip && (await isBlocked(env, request, ip))) {
    return new Response("Forbidden", { status: 403 });
  }

  // 快速切换主题触发的强制挑战：即使来自中国大陆 ASN、白名单 IP、
  // 只有有效 __gate cookie 或经 Cloudflare verifiedBot 验证才放行；cf_clearance 不再作为绕过依据。
  if (forceChallenge) {
    defer(
      context,
      logEvent(env, "gate_redirect", request, {
        outcome: "forced",
        status: 302,
        path: pathname,
        message: "force_theme_challenge",
      }),
    );
    return forceGateRedirect(request, hostname, pathname, url.search);
  }

  const cookie = getCookie(GATE_COOKIE, request.headers.get("Cookie"));
  const gated = !(
    whitelisted ||
    trustedCrawler ||
    (cookie && (await isValidGateCookie(cookie, env.GATE_HMAC_KEY)))
  );

  if (!gated && !forceChallenge) {
    if (whitelisted || trustedCrawler) {
      defer(
        context,
        logEvent(env, "gate_bypass", request, {
          outcome: "trusted",
          status: 200,
          path: pathname,
          message: whitelisted ? "gate_whitelist" : "cf_verified_bot",
        }),
      );
    }

    const lang = detectLang(request);
    const asset = pageAsset(hostname, pathname, lang);
    if (asset) {
      const authRedirect = await adminAuthRedirect(env, request, hostname);
      if (authRedirect) return withLangCookie(request, authRedirect);
      const resp = await cachedPageAsset(context, asset, lang);
      if (resp?.ok) return withLangCookie(request, resp);
    }
    return next();
  }

  // 未验证：在对应域名渲染门禁页（同域名 challenge，不再跳去 auth。<root_domain>）。
  const gateUrl = new URL("/__gate", `https://${hostname}/`);
  gateUrl.searchParams.set("host", hostname);
  gateUrl.searchParams.set("next", pathname + url.search);
  defer(
    context,
    logEvent(env, "gate_redirect", request, {
      outcome: "unverified",
      status: 302,
      path: pathname,
      message: "redirect_to_gate",
    }),
  );
  return withLangCookie(request, new Response(null, {
    status: 302,
    headers: {
      Location: gateUrl.toString(),
      "Cache-Control": "no-store",
    },
  }));
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const startedAt = Date.now();
  const resp = withSecurityHeaders(request, await handleOnRequest(context));

  if (shouldTrackVisit(request, url)) {
    if (typeof context.waitUntil === "function") {
      context.waitUntil(recordVisit(env, request, resp.status));
    } else {
      void recordVisit(env, request, resp.status);
    }
  }
  if (shouldTrackRay(request, url)) {
    const durationMs = Date.now() - startedAt;
    if (typeof context.waitUntil === "function") {
      context.waitUntil(recordRay(env, request, resp.status, durationMs));
    } else {
      void recordRay(env, request, resp.status, durationMs);
    }
  }
  return resp;
};
