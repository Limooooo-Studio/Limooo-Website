/** GET /api/auth/status */

import { requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAuth(context.env, context.request);
  if (!session) {
    return Response.json({ authed: false, user: null, role: "viewer" });
  }
  return Response.json({
    authed: true,
    user: session.user,
    role: session.role,
  });
};
