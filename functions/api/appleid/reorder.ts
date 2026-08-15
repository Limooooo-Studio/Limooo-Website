/** PUT /api/appleid/reorder（需 admin） */

import { execute } from "../../_lib/d1";
import { requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const session = await requireAuth(context.env, context.request);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (session.role !== "admin") return Response.json({ error: "只读账户，无写入权限" }, { status: 403 });

  let order: unknown;
  try {
    order = ((await context.request.json()) as { order?: unknown }).order;
  } catch {
    return Response.json({ error: "无效请求" }, { status: 400 });
  }
  if (!Array.isArray(order)) return Response.json({ error: "无效请求" }, { status: 400 });

  for (let i = 0; i < order.length; i++) {
    await execute(context.env.DB, "UPDATE apple_accounts SET sort_order = ? WHERE id = ?", i, Number(order[i]));
  }
  return Response.json({ status: "ok" });
};
