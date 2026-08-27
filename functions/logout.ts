/** GET /logout → 撤销 D1 会话，清 cookie，跳 authentik 登出 */

import { buildLogoutUrl } from "./_lib/oidc";
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
  const resp = new Response(null, { status: 302, headers: { Location: buildLogoutUrl(env, next) } });
  resp.headers.append("Set-Cookie", clearSessionCookie());
  resp.headers.append("Set-Cookie", clearPendingCookie());
  return resp;
};
