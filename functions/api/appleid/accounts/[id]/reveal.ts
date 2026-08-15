/** POST /api/appleid/accounts/:id/reveal（需登录，临时返回明文） */

import { queryAll } from "../../../../_lib/d1";
import { fernetDecrypt } from "../../../../_lib/fernet";
import { requireAuth } from "../../../../_lib/session";
import type { Env } from "../../../../_lib/env";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  if (!(await requireAuth(context.env, context.request))) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }
  const id = Number((context.params as { id?: string }).id);
  const rows = await queryAll<{ password: string }>(
    context.env.DB,
    "SELECT password FROM apple_accounts WHERE id = ?",
    id,
  );
  if (!rows.length) return Response.json({ error: "未找到" }, { status: 404 });

  let plain = rows[0].password;
  try {
    if (context.env.APPLEID_ENCRYPTION_KEY) {
      plain = await fernetDecrypt(rows[0].password, context.env.APPLEID_ENCRYPTION_KEY);
    }
  } catch {
    // 兼容旧明文
  }
  return Response.json({ password: plain });
};
