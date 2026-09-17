/**
 * GET /logout → 撤销 D1 会话、清 cookie，再跳 Access 登出端点（docs/17 §11.6）。
 *
 * 两步缺一不可：
 * - 撤销 D1 `auth_sessions`：本系统侧的会话立即失效（requireAuth fail-closed）；
 * - 跳 Access 登出：清 Cloudflare 侧的 `CF_Authorization`，否则下一个请求会
 *   被 Access 用残留会话自动重新认证，「退出」看起来没生效。
 */

import { accessLogoutUrl, accessTeamDomain } from "./_lib/access";
import {
  clearPendingCookie,
  clearSessionCookie,
  configErrorResponse,
  readSession,
  revokeAuthSession,
  runtimeConfigError,
} from "./_lib/session";
import type { Env } from "./_lib/env";
import { logEvent } from "./_lib/logging";
import { BASE_URL } from "./_lib/config";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const configError = runtimeConfigError(env);
  if (configError) return configErrorResponse(configError);

  const next = url.searchParams.get("next") || `${BASE_URL}/`;
  const session = await readSession(env, request.headers.get("Cookie"));
  if (session?.sid) {
    const revoked = await revokeAuthSession(env, session.sid);
    if (!revoked) {
      await logEvent(env, "logout", request, {
        outcome: "failed",
        status: 503,
        message: "revoke_unavailable",
      });
      return configErrorResponse("auth_sessions_unavailable");
    }
  }

  await logEvent(env, "logout", request, {
    outcome: "ok",
    status: 302,
    message: session ? `sid=${session.sid.slice(0, 8)}` : "no_session",
  });

  // Access 未配置时退化为只跳 next，本地会话已经撤销，不影响安全性。
  const target = accessTeamDomain(env) ? accessLogoutUrl(env, next) : next;
  const resp = new Response(null, { status: 302, headers: { Location: target } });
  resp.headers.append("Set-Cookie", clearSessionCookie());
  resp.headers.append("Set-Cookie", clearPendingCookie());
  return resp;
};
