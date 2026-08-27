/** POST /api/appleid/accounts/:id/reveal（仅 admin + CSRF，返回后审计并立即丢弃） */

import { queryAll } from "../../../../_lib/d1";
import { fernetDecrypt } from "../../../../_lib/fernet";
import { authUnavailableResponse, requireAuth } from "../../../../_lib/session";
import { verifyCsrf } from "../../../../_lib/csrf";
import { parseAccountId } from "../../../../_lib/appleid";
import { logEvent } from "../../../../_lib/logging";
import type { Env } from "../../../../_lib/env";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth(context.env, context.request);
  } catch {
    return authUnavailableResponse();
  }
  if (!session) return Response.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (session.role !== "admin") {
    return Response.json({ error: "只读账户，无写入权限" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const id = parseAccountId((context.params as { id?: string }).id);
  if (!id) return Response.json({ error: "无效请求" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  if (!(await verifyCsrf(context.env, context.request))) {
    return Response.json({ error: "无权限" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const rows = await queryAll<{ password: string }>(
    context.env.DB,
    "SELECT password FROM apple_accounts WHERE id = ?",
    id,
  );
  if (!rows.length) return Response.json({ error: "未找到" }, { status: 404, headers: { "Cache-Control": "no-store" } });

  let plain = "";
  try {
    if (!context.env.APPLEID_ENCRYPTION_KEY) throw new Error("missing encryption key");
    plain = await fernetDecrypt(rows[0].password, context.env.APPLEID_ENCRYPTION_KEY);
  } catch {
    await logEvent(context.env, "audit_event", context.request, {
      outcome: "decrypt_failed",
      status: 500,
      accountId: id,
      actorSub: session.sub,
      message: "password_reveal_failed",
    });
    return Response.json(
      { error: "解密失败，已记录审计事件" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  await logEvent(context.env, "audit_event", context.request, {
    outcome: "password_revealed",
    status: 200,
    accountId: id,
    actorSub: session.sub,
    message: "password_reveal",
  });
  return Response.json({ password: plain }, { headers: { "Cache-Control": "no-store" } });
};
