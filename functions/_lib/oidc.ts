/** authentik OIDC（授权码流程），与现有 Flask 部署共用同一客户端 */

import type { Env } from "./env";
import type { SessionData } from "./session";

export const REDIRECT_URI = "https://limooo.cn/login/callback";

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

export function buildAuthorizeUrl(env: Env, state: string): string {
  const base = (env.AUTHENTIK_URL || "https://identity.limooo.cn").replace(/\/$/, "");
  const params = new URLSearchParams({
    client_id: env.AUTHENTIK_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email groups",
    state,
  });
  return `${base}/application/o/authorize/?${params.toString()}`;
}

export async function exchangeCode(env: Env, code: string): Promise<SessionData | null> {
  const tokenUrl = (env.AUTHENTIK_URL || "https://identity.limooo.cn").replace(/\/$/, "") + "/application/o/token/";
  const body = new URLSearchParams({
    client_id: env.AUTHENTIK_CLIENT_ID ?? "",
    client_secret: env.AUTHENTIK_CLIENT_SECRET ?? "",
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let claims: IdTokenClaims | null = null;
  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    const result = (await resp.json()) as { id_token?: string };
    if (result.id_token) {
      claims = b64urlDecodeJson(result.id_token.split(".")[1]) as IdTokenClaims;
    }
  } catch {
    claims = null;
  } finally {
    clearTimeout(timer);
  }
  if (!claims || !claims.sub) return null;

  const adminGroups = (env.AUTHENTIK_ADMIN_GROUPS || "authentik Admins")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const groups = Array.isArray(claims.groups) ? claims.groups : claims.groups ? [claims.groups] : [];
  const email = claims.preferred_username || claims.email || "";
  const name = claims.name || email;

  return {
    sub: claims.sub,
    user: { email, name },
    role: groups.some((g) => adminGroups.includes(g)) ? "admin" : "viewer",
    authAt: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 86400,
  };
}

export function buildLogoutUrl(env: Env, nextUrl: string): string {
  const base = (env.AUTHENTIK_URL || "https://identity.limooo.cn").replace(/\/$/, "");
  const params = new URLSearchParams({ post_logout_redirect_uri: nextUrl });
  return `${base}/application/o/limooo/end-session/?${params.toString()}`;
}
