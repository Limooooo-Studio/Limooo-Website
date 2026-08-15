/** GET /login → 跳转 authentik 授权（state 存 pending cookie） */

import { buildAuthorizeUrl } from "./_lib/oidc";
import { createPendingCookie } from "./_lib/session";
import type { Env } from "./_lib/env";

function safeNext(raw: string | null): string {
  if (!raw) return "https://limooo.cn/";
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  if (/^https:\/\/limooo\.cn\//.test(raw)) return raw;
  return "https://limooo.cn/";
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const state = crypto.randomUUID().replace(/-/g, "");

  return new Response(null, {
    status: 302,
    headers: {
      Location: buildAuthorizeUrl(env, state),
      "Set-Cookie": await createPendingCookie(env, state, next),
    },
  });
};
