/** GET /logout → 清会话，跳 authentik 登出 */

import { buildLogoutUrl } from "./_lib/oidc";
import { clearPendingCookie, clearSessionCookie } from "./_lib/session";
import type { Env } from "./_lib/env";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const next = url.searchParams.get("next") || "https://limooo.cn/";

  return new Response(null, {
    status: 302,
    headers: {
      Location: buildLogoutUrl(env, next),
      "Set-Cookie": [clearSessionCookie(), clearPendingCookie()].join(", "),
    },
  });
};
