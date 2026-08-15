/** GET /api/appleid/accounts（列表，脱敏） / POST（新增，需 admin） */

import { queryAll, execute } from "../../_lib/d1";
import { fernetDecrypt, fernetEncrypt } from "../../_lib/fernet";
import { requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

const APPLEID_DOMAIN = "@appleid.limooo.cn";

interface Row {
  id: number;
  email: string;
  password: string;
  notes: string;
  sort_order: number;
}

function normalizeEmail(raw: string): string {
  return raw.trim().split("@", 1)[0] + APPLEID_DOMAIN;
}

function mask(password: string): string {
  return "·".repeat(password.length || 0);
}

async function decryptOrRaw(env: Env, stored: string): Promise<string> {
  try {
    if (env.APPLEID_ENCRYPTION_KEY) return await fernetDecrypt(stored, env.APPLEID_ENCRYPTION_KEY);
  } catch {
    // 兼容旧明文数据
  }
  return stored;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (!(await requireAuth(context.env, context.request))) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }
  const rows = await queryAll<Row>(
    context.env.DB,
    "SELECT id, email, password, notes, sort_order FROM apple_accounts ORDER BY sort_order, email",
  );
  const result = [];
  for (const r of rows) {
    result.push({
      id: r.id,
      email: r.email,
      password: mask(await decryptOrRaw(context.env, r.password)),
      notes: r.notes,
      sort_order: r.sort_order,
    });
  }
  return Response.json(result);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const session = await requireAuth(context.env, context.request);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (session.role !== "admin") return Response.json({ error: "只读账户，无写入权限" }, { status: 403 });
  if (!context.env.APPLEID_ENCRYPTION_KEY) {
    return Response.json({ error: "服务器未配置加密密钥" }, { status: 500 });
  }

  let data: { email?: string; password?: string; notes?: string };
  try {
    data = (await context.request.json()) as typeof data;
  } catch {
    return Response.json({ error: "无效请求" }, { status: 400 });
  }
  if (!data.email || !data.password) {
    return Response.json({ error: "邮箱和密码不能为空" }, { status: 400 });
  }

  const email = normalizeEmail(data.email);
  const encrypted = await fernetEncrypt(data.password, context.env.APPLEID_ENCRYPTION_KEY);
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
      email,
      encrypted,
      data.notes ?? "",
      sortOrder,
    );
  } catch {
    // D1 唯一约束冲突时 run() 会抛错，统一按"已存在"处理
  }
  if (!ok) return Response.json({ error: "该邮箱已存在" }, { status: 409 });
  return Response.json({ status: "ok" });
};
