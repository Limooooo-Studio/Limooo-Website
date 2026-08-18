/** GET /login/callback → 兑换 code，签发会话 cookie，回跳 next */

import { exchangeCode, redirectUriFor } from "../_lib/oidc";
import { clearPendingCookie, createSessionCookie, readPending } from "../_lib/session";
import type { Env } from "../_lib/env";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const pending = await readPending(env, request.headers.get("Cookie"));
  if (!pending || pending.state !== state || !code) {
    return Response.redirect("https://limooo.cn/?error=bad_state", 302);
  }

  const result = await exchangeCode(env, code, redirectUriFor(url.hostname));
  if (!result.session) {
    return Response.redirect(`https://limooo.cn/?error=auth_failed&reason=${encodeURIComponent(result.reason)}`, 302);
  }
  const session = result.session;

  // pending.next 只可能是站内相对路径或 https://limooo.cn/ 开头的完整 URL（login.ts 已过滤）
  const next = new URL(pending.next, "https://limooo.cn/").toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      "Set-Cookie": [clearPendingCookie(), await createSessionCookie(env, session)].join(", "),
    },
  });
};
