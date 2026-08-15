import type { D1Database } from "./d1";

export interface Env {
  // 门禁（阶段 1）
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET: string;
  GATE_HMAC_KEY: string;
  // 登录（authentik OIDC）
  AUTHENTIK_URL?: string;
  AUTHENTIK_CLIENT_ID?: string;
  AUTHENTIK_CLIENT_SECRET?: string;
  AUTHENTIK_ADMIN_GROUPS?: string;
  SESSION_HMAC_KEY?: string;
  // Apple ID 密码加密（Fernet 密钥，与现有 Flask 部署共用）
  APPLEID_ENCRYPTION_KEY?: string;
  // D1（阶段 3：访客统计 / 封禁名单 / Apple ID）
  DB?: D1Database;
  // Pages 静态资源绑定（中间件按语言取预渲染页面）
  ASSETS?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}
