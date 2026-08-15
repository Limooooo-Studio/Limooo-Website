/** PUT /api/appleid/accounts/:id（更新） / DELETE（删除，需 admin） */

import { queryAll, execute } from "../../../_lib/d1";
import { fernetEncrypt } from "../../../_lib/fernet";
import { requireAuth } from "../../../_lib/session";
import type { Env } from "../../../_lib/env";

const APPLEID_DOMAIN = "@appleid.limooo.cn";

function normalizeEmail(raw: string): string {
  return raw.trim().split("@", 1)[0] + APPLEID_DOMAIN;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const session = await requireAuth(context.env, context.request);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (session.role !== "admin") return Response.json({ error: "只读账户，无写入权限" }, { status: 403 });

  const id = Number((context.params as { id?: string }).id);
  let data: { email?: string; password?: string; notes?: string; password_changed?: boolean };
  try {
    data = (await context.request.json()) as typeof data;
  } catch {
    return Response.json({ error: "无效请求" }, { status: 400 });
  }

  let password = "";
  if (data.password_changed && data.password) {
    if (!context.env.APPLEID_ENCRYPTION_KEY) {
      return Response.json({ error: "服务器未配置加密密钥" }, { status: 500 });
    }
    password = await fernetEncrypt(data.password, context.env.APPLEID_ENCRYPTION_KEY);
  } else {
    const existing = await queryAll<{ password: string }>(
      context.env.DB,
      "SELECT password FROM apple_accounts WHERE id = ?",
      id,
    );
    password = existing.length ? existing[0].password : "";
  }

  const ok = await execute(
    context.env.DB,
    "UPDATE apple_accounts SET email = ?, password = ?, notes = ?, updated_at = datetime('now') WHERE id = ?",
    normalizeEmail(data.email ?? ""),
    password,
    data.notes ?? "",
    id,
  );
  return Response.json({ status: ok ? "ok" : "not found" }, { status: ok ? 200 : 404 });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const session = await requireAuth(context.env, context.request);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (session.role !== "admin") return Response.json({ error: "只读账户，无写入权限" }, { status: 403 });

  const id = Number((context.params as { id?: string }).id);
  const ok = await execute(context.env.DB, "DELETE FROM apple_accounts WHERE id = ?", id);
  return Response.json({ status: ok ? "ok" : "not found" }, { status: ok ? 200 : 404 });
};
