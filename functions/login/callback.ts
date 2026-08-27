/** GET /login/callback → 校验 nonce/PKCE/ID Token，写入 auth_sessions，签发会话 cookie */

import { exchangeCode, oidcConfigError, redirectUriFor } from "../_lib/oidc";
import {
  clearPendingCookie,
  configErrorResponse,
  createAuthSession,
  createSessionCookie,
  randomToken,
  readPending,
  runtimeConfigError,
} from "../_lib/session";
import type { Env } from "../_lib/env";
import { logEvent } from "../_lib/logging";
import { BASE_URL } from "../_lib/config";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const startedAt = Date.now();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const configError = runtimeConfigError(env) || oidcConfigError(env);
  if (configError) return configErrorResponse(configError);

  const pending = await readPending(env, request.headers.get("Cookie"));
  if (!pending || pending.state !== state || !code) {
    await logEvent(env, "login_callback", request, {
      outcome: "bad_state",
      status: 302,
      durationMs: Date.now() - startedAt,
      message: "missing_or_invalid_state",
    });
    const bad = Response.redirect(`${BASE_URL}/?error=bad_state`, 302);
    bad.headers.append("Set-Cookie", clearPendingCookie());
    return bad;
  }

  const result = await exchangeCode(env, code, redirectUriFor(url.hostname), {
    nonce: pending.nonce,
    codeVerifier: pending.codeVerifier,
  });
  if (!result.session) {
    await logEvent(env, "login_callback", request, {
      outcome: "error",
      status: 302,
      durationMs: Date.now() - startedAt,
      message: result.reason,
    });
    return Response.redirect(`${BASE_URL}/?error=auth_failed&reason=${encodeURIComponent(result.reason)}`, 302);
  }

  const session = {
    sid: randomToken(24),
    ...result.session,
  };
  if (!(await createAuthSession(env, session))) {
    await logEvent(env, "login_callback", request, {
      outcome: "error",
      status: 503,
      durationMs: Date.now() - startedAt,
      message: "auth_sessions_unavailable",
    });
    return configErrorResponse("auth_sessions_unavailable");
  }

  // pending.next 只可能是站内相对路径或白名单主站开头的完整 URL（login.ts 已过滤）。
  // 按当前子域解析相对路径（visitor/appleid 的 next=/ 应回本域而不是主站）
  const next = new URL(pending.next, `https://${url.hostname}/`).toString();
  // 多个 Set-Cookie 必须分开发（逗号拼接进一个头在 Safari 下只认第一个，
  // 会话 cookie 写不进去会导致登录后回跳再判定未登录 → 无限重定向）
  const resp = new Response(null, { status: 302, headers: { Location: next } });
  resp.headers.append("Set-Cookie", clearPendingCookie());
  resp.headers.append("Set-Cookie", await createSessionCookie(env, session));
  await logEvent(env, "login_callback", request, {
    outcome: "ok",
    status: 302,
    durationMs: Date.now() - startedAt,
    message: `role=${session.role}`,
  });
  return resp;
};
