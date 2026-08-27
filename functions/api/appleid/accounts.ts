/** GET /api/appleid/accounts（列表，脱敏） / POST（新增，需 admin + CSRF） */

import { queryAll, execute } from "../../_lib/d1";
import { fernetEncrypt } from "../../_lib/fernet";
import { authUnavailableResponse, requireAuth } from "../../_lib/session";
import { verifyCsrf } from "../../_lib/csrf";
import { maskPassword, validateCreatePayload } from "../../_lib/appleid";
import type { Env } from "../../_lib/env";

interface Row {
  id: number;
  email: string;
  password: string;
  notes: string;
  sort_order: number;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth(context.env, context.request);
  } catch {
    return authUnavailableResponse();
  }
  if (!session) {
    return Response.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const rows = await queryAll<Row>(
    context.env.DB,
    "SELECT id, email, password, notes, sort_order FROM apple_accounts ORDER BY sort_order, email",
  );
  return Response.json(
    rows.map((r) => ({
      id: r.id,
      email: r.email,
      password: maskPassword(r.password),
      notes: r.notes,
      sort_order: r.sort_order,
    })),
    { headers: { "Cache-Control": "no-store" } },
  );
};

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
  if (!(await verifyCsrf(context.env, context.request))) {
    return Response.json({ error: "无权限" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!context.env.APPLEID_ENCRYPTION_KEY) {
    return Response.json({ error: "服务器未配置加密密钥" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }

  let data: unknown;
  try {
    data = await context.request.json();
  } catch {
    return Response.json({ error: "无效请求" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const parsed = validateCreatePayload(data);
  if (!parsed) {
    return Response.json({ error: "无效请求" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const encrypted = await fernetEncrypt(parsed.password, context.env.APPLEID_ENCRYPTION_KEY);
  const max = await queryAll<{ n: number }>(
    context.env.DB,
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM apple_accounts",
  );
  const sortOrder = max.length ? max[0].n : 0;

  let ok = false;
  try {
    ok = await execute(
      context.env.DB,
      "INSERT INTO apple_accounts (email, password, notes, sort_order) VALUES (?, ?, ?, ?)",
      parsed.email,
      encrypted,
      parsed.notes,
      sortOrder,
    );
  } catch {
    return Response.json({ error: "该邮箱已存在" }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  if (!ok) {
    return Response.json({ error: "写入失败" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
};
