/**
 * GET /login → Cloudflare Access 身份落地（docs/17 §11.6 / §11.10）
 *
 * Access 前置在 `visitor.limooo.cn` / `apple.limooo.cn` / `admin.limooo.cn` 之前，
 * 已认证用户到达这里时请求头带 `Cf-Access-Jwt-Assertion`。本端点负责：
 *
 *   1. 验签 Access JWT（**必须自验**，否则伪造请求头即可冒充管理员）；
 *   2. 用 AUD 判定 admin / viewer；
 *   3. 写入 D1 `auth_sessions` 并签发跨子域会话 cookie；
 *   4. 302 回 `next`。
 *
 * 会话层完全沿用 docs/09：requireAuth 同时校验签名 cookie 与撤销表，
 * 撤销表不可用时敏感接口 503，不凭 cookie 放行。
 */

import {
  accessAssertion,
  accessConfigError,
  accessLogoutUrl,
  verifyAccessJwt,
} from "./_lib/access";
import {
  configErrorResponse,
  createAuthSession,
  createSessionCookie,
  randomToken,
  runtimeConfigError,
} from "./_lib/session";
import type { Env } from "./_lib/env";
import { logEvent } from "./_lib/logging";
import { safeNextUrl } from "./_lib/routing";
import { BASE_URL } from "./_lib/config";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const configError = runtimeConfigError(env) || accessConfigError(env);
  if (configError) return configErrorResponse(configError);

  const next = safeNextUrl(new URL(request.url).searchParams.get("next"));
  const identity = await verifyAccessJwt(env, accessAssertion(request));
  if (!identity) {
    await logEvent(env, "login_attempt", request, {
      outcome: "failed",
      status: 401,
      message: "access_jwt_invalid",
    });
    // 走到这里说明 Access 没生效（域名没挂 Access、或 JWT 被篡改）。
    // 直接回 401 而不是自建登录页：Access 是唯一身份来源。
    return new Response("Unauthorized: no valid Cloudflare Access token\n", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const session = {
    sid: randomToken(24),
    sub: identity.sub,
    user: { email: identity.email, name: identity.email },
    role: identity.role,
    authAt: now,
  };
  if (!(await createAuthSession(env, session))) {
    await logEvent(env, "login_attempt", request, {
      outcome: "failed",
      status: 503,
      message: "auth_sessions_unavailable",
    });
    return configErrorResponse("auth_sessions_unavailable");
  }

  await logEvent(env, "login_attempt", request, {
    outcome: "ok",
    status: 302,
    message: `role=${session.role}`,
  });

  // 相对 next 按主站解析；绝对地址（白名单主机）直接用。
  const target = next.startsWith("/") ? `${BASE_URL}${next}` : next;
  const resp = new Response(null, { status: 302, headers: { Location: target } });
  resp.headers.append("Set-Cookie", await createSessionCookie(env, session));
  return resp;
};

/** 供 /logout 使用：把用户也带出 Access 会话。 */
export function accessLogout(env: Env, nextUrl: string): string {
  return accessLogoutUrl(env, nextUrl);
}
