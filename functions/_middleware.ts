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
  GATE_HOSTNAME,
  IMAGES_HOSTNAME,
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
  const gateUrl = new URL("/__gate", `https://${GATE_HOSTNAME}/`);
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

  // 图片子域的门面页同样走主站主题切换逻辑；强制挑战直接去 auth。<root_domain>。
  if (forceChallenge && hostname === IMAGES_HOSTNAME) {
    return forceGateRedirect(request, hostname, pathname, url.search);
  }

  // images.<root_domain>：图片子域公开访问；页面路径吐门面页，其余映射 /static。
  if (hostname === IMAGES_HOSTNAME) {
    const lang = detectLang(request);
    const page = pageAsset(hostname, pathname, lang);
    if (page && env.ASSETS) {
      const resp = await env.ASSETS.fetch(new URL(page, BASE_URL));
      if (resp.ok) {
        return withLangCookie(request, new Response(resp.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, max-age=300",
            "Vary": "Cookie",
          },
        }));
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
  if (forceChallenge && hostname !== GATE_HOSTNAME) {
    await logEvent(env, "gate_redirect", request, {
      outcome: "forced",
      status: 302,
      path: pathname,
      message: "force_theme_challenge",
    });
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
      await logEvent(env, "gate_bypass", request, {
        outcome: "trusted",
        status: 200,
        path: pathname,
        message: whitelisted ? "gate_whitelist" : "cf_verified_bot",
      });
    }
    // 已通过门禁；若仍停在验证子域，送回原主机原路径。
    if (hostname === GATE_HOSTNAME) {
      const back = safeNextPath(url.searchParams.get("next") ?? "/");
      const host = sanitizeHost(url.searchParams.get("host"));
      let resp = Response.redirect(viaRedirect(host, back), 302);
      if (!cookie || !(await isValidGateCookie(cookie, env.GATE_HMAC_KEY))) {
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

    const asset = pageAsset(hostname, pathname, detectLang(request));
    if (asset && env.ASSETS) {
      const authRedirect = await adminAuthRedirect(env, request, hostname);
      if (authRedirect) return withLangCookie(request, authRedirect);
      const resp = await env.ASSETS.fetch(new URL(asset, BASE_URL));
      if (resp.ok) {
        return withLangCookie(request, new Response(resp.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, max-age=300",
            "Vary": "Cookie",
          },
        }));
      }
    }
    return next();
  }

  // 未验证：只在 auth.<root_domain> 渲染门禁页，其它主机 302 过去。
  if (hostname !== GATE_HOSTNAME) {
    const gateUrl = new URL("/__gate", `https://${GATE_HOSTNAME}/`);
    gateUrl.searchParams.set("host", hostname);
    gateUrl.searchParams.set("next", pathname + url.search);
    await logEvent(env, "gate_redirect", request, {
      outcome: "unverified",
      status: 302,
      path: pathname,
      message: "redirect_to_gate",
    });
    return withLangCookie(request, new Response(null, {
      status: 302,
      headers: {
        Location: gateUrl.toString(),
        "Cache-Control": "no-store",
      },
    }));
  }

  return renderGatePage(context, {
    host: url.searchParams.get("host") ?? undefined,
    next: url.searchParams.get("next") ?? "/",
  });
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
