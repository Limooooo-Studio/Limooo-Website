/** POST /logout/backchannel — authentik Backchannel Logout 入口 */

import { verifyBackchannelLogout } from "../_lib/oidc";
import {
  authUnavailableResponse,
  configErrorResponse,
  revokeAuthSessionsBySub,
  runtimeConfigError,
} from "../_lib/session";
import type { Env } from "../_lib/env";
import { logEvent } from "../_lib/logging";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const configError = runtimeConfigError(env);
  if (configError) return configErrorResponse(configError);

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return Response.json({ ok: false, error: "unsupported_content_type" }, { status: 400 });
  }

  let token: string | null = null;
  try {
    const form = await request.formData();
    token = typeof form.get("logout_token") === "string" ? form.get("logout_token") as string : null;
  } catch {
    return Response.json({ ok: false, error: "invalid_form" }, { status: 400 });
  }
  if (!token) {
    await logEvent(env, "backchannel_logout", request, {
      outcome: "failed",
      status: 400,
      message: "missing_token",
    });
    return Response.json({ ok: false, error: "missing_token" }, { status: 400 });
  }

  const verified = await verifyBackchannelLogout(env, token);
  if (!verified.ok) {
    await logEvent(env, "backchannel_logout", request, {
      outcome: "failed",
      status: 400,
      message: verified.reason,
    });
    return Response.json({ ok: false, error: "invalid_token" }, { status: 400 });
  }
  const sub = verified.claims.sub;
  if (!sub) {
    return Response.json({ ok: false, error: "missing_sub" }, { status: 400 });
  }
  const revoked = await revokeAuthSessionsBySub(env, sub);
  if (!revoked) {
    await logEvent(env, "backchannel_logout", request, {
      outcome: "failed",
      status: 503,
      message: "revoke_unavailable",
    });
    return authUnavailableResponse();
  }
  await logEvent(env, "backchannel_logout", request, {
    outcome: "ok",
    status: 200,
    message: "accepted",
  });
  return Response.json({ ok: true });
};
