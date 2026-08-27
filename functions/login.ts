/** GET /login → 生成 nonce + PKCE + state，跳转 authentik 授权 */

import { buildAuthorizeUrl, deriveCodeChallenge, oidcConfigError, redirectUriFor } from "./_lib/oidc";
import {
  configErrorResponse,
  createPendingCookie,
  randomToken,
  runtimeConfigError,
} from "./_lib/session";
import type { Env } from "./_lib/env";
import { logEvent } from "./_lib/logging";
import { safeNextUrl } from "./_lib/routing";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const startedAt = Date.now();
  const configError = runtimeConfigError(env) || oidcConfigError(env);
  if (configError) return configErrorResponse(configError);

  const next = safeNextUrl(url.searchParams.get("next"));
  const state = randomToken(24);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(32);
  const redirectUri = redirectUriFor(url.hostname);
  const pkceEnabled = env.AUTHENTIK_PKCE_ENABLED !== "false";
  const codeChallenge = pkceEnabled ? await deriveCodeChallenge(codeVerifier) : undefined;

  await logEvent(env, "login_attempt", request, {
    outcome: "started",
    status: 302,
    durationMs: Date.now() - startedAt,
    message: `redirect_uri=${redirectUri}`,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: buildAuthorizeUrl(env, state, redirectUri, { nonce, codeChallenge }),
      "Set-Cookie": await createPendingCookie(env, {
        state,
        nonce,
        codeVerifier,
        next,
      }),
    },
  });
};
