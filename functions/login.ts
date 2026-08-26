/** GET /login → 跳转 authentik 授权（state 存 pending cookie） */

import { buildAuthorizeUrl, redirectUriFor } from "./_lib/oidc";
import { createPendingCookie } from "./_lib/session";
import type { Env } from "./_lib/env";
import { logEvent } from "./_lib/logging";

function safeNext(raw: string | null): string {
  if (!raw) return "https://limooo.cn/";
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  // 放行主站及已迁移到 Pages 的管理子域（登录后回跳原页面）
  if (/^https:\/\/(limooo\.cn|visitor\.limooo\.cn|appleid\.limooo\.cn)\//.test(raw)) return raw;
  return "https://limooo.cn/";
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const startedAt = Date.now();
  const next = safeNext(url.searchParams.get("next"));
  const state = crypto.randomUUID().replace(/-/g, "");
  const redirectUri = redirectUriFor(url.hostname);

  await logEvent(env, "login_attempt", request, {
    outcome: "started",
    status: 302,
    durationMs: Date.now() - startedAt,
    message: `redirect_uri=${redirectUri}`,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: buildAuthorizeUrl(env, state, redirectUri),
      "Set-Cookie": await createPendingCookie(env, state, next),
    },
  });
};
