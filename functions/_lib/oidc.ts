/** authentik OIDC（授权码流程），与现有 Flask 部署共用同一客户端 */

import type { Env } from "./env";
import type { SessionData } from "./session";

/** 按子域返回 OIDC 回调地址（authentik 里已按域配置 redirect_uri 白名单） */
export function redirectUriFor(host: string): string {
  if (host === "visitor.limooo.cn") return "https://visitor.limooo.cn/login/callback";
  if (host === "appleid.limooo.cn") return "https://appleid.limooo.cn/login/callback";
  return "https://limooo.cn/login/callback";
}

function b64urlDecodeJson(input: string): unknown {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

interface IdTokenClaims {
  sub?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  groups?: string[] | string;
}

export function buildAuthorizeUrl(env: Env, state: string, redirectUri: string): string {
  const base = (env.AUTHENTIK_URL || "https://identity.limooo.cn").replace(/\/$/, "");
  const params = new URLSearchParams({
    client_id: env.AUTHENTIK_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid profile email groups",
    state,
  });
  return `${base}/application/o/authorize/?${params.toString()}`;
}

export async function exchangeCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ session: SessionData; reason?: never } | { session?: never; reason: string }> {
  const tokenUrl = (env.AUTHENTIK_URL || "https://identity.limooo.cn").replace(/\/$/, "") + "/application/o/token/";
  const body = new URLSearchParams({
    client_id: env.AUTHENTIK_CLIENT_ID ?? "",
    client_secret: env.AUTHENTIK_CLIENT_SECRET ?? "",
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let claims: IdTokenClaims | null = null;
  let reason = "";
  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // nginx 的 $ua_deny 只放行含 Mozilla 的 UA，服务端 token 交换必须带浏览器 UA
        "User-Agent": "Mozilla/5.0 (compatible; limooo-pages/1.0)",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await resp.text();
    let result: { id_token?: string; error?: string; error_description?: string } = {};
    try {
      result = JSON.parse(text);
    } catch {
      reason = `bad_json:${text.slice(0, 200)}`;
    }
    if (!resp.ok) reason = reason || `http_${resp.status}:${result.error_description || result.error || text.slice(0, 200)}`;
    else if (!result.id_token) reason = reason || "no_id_token";
    if (result.id_token) {
      try {
        claims = b64urlDecodeJson(result.id_token.split(".")[1]) as IdTokenClaims;
      } catch (e) {
        reason = reason || `id_token_parse:${String(e)}`;
      }
    }
  } catch {
    reason = "fetch_exception";
  } finally {
    clearTimeout(timer);
  }
  if (!claims) reason = reason || "no_claims";
  else if (!claims.sub) reason = reason || "no_sub";
  if (!claims || !claims.sub) return { reason };

  const adminGroups = (env.AUTHENTIK_ADMIN_GROUPS || "authentik Admins")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const groups = Array.isArray(claims.groups) ? claims.groups : claims.groups ? [claims.groups] : [];
  const email = claims.preferred_username || claims.email || "";
  const name = claims.name || email;

  return {
    session: {
      sub: claims.sub,
      user: { email, name },
      role: groups.some((g) => adminGroups.includes(g)) ? "admin" : "viewer",
      authAt: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7 * 86400,
    },
  };
}

export function buildLogoutUrl(env: Env, nextUrl: string): string {
  const base = (env.AUTHENTIK_URL || "https://identity.limooo.cn").replace(/\/$/, "");
  const params = new URLSearchParams({ post_logout_redirect_uri: nextUrl });
  return `${base}/application/o/limooo/end-session/?${params.toString()}`;
}
