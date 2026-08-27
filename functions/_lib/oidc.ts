/** authentik OIDC（授权码 + PKCE），与现有 Flask 部署共用同一客户端 */

import type { Env } from "./env";
import {
  APPLEID_HOSTNAME,
  AUTHENTIK_ADMIN_GROUPS_DEFAULT,
  AUTHENTIK_PROVIDER_SLUG,
  BASE_URL,
  IDENTITY_URL,
  VISITOR_HOSTNAME,
} from "./config";

const textEncoder = new TextEncoder();
const USERINFO_TIMEOUT_MS = 10000;
const JWKS_TIMEOUT_MS = 10000;
const TOKEN_TIMEOUT_MS = 10000;
const CLOCK_SKEW_SECONDS = 60;
const OIDC_USER_AGENT = "Mozilla/5.0 (compatible; limooo-pages/1.0)";

export interface OidcUserSession {
  sub: string;
  user: { email: string; name: string };
  role: "admin" | "viewer";
  authAt: number;
}

export interface OidcExchangeOptions {
  nonce: string;
  codeVerifier?: string;
}

export type OidcExchangeResult =
  | { session: OidcUserSession; reason?: never }
  | { session?: never; reason: string };

export type OidcTokenResult =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: string };

interface IdTokenClaims {
  sub?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  groups?: unknown;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  events?: Record<string, unknown>;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwkLike {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

/** 按子域返回 OIDC 回调地址（authentik 里已按域配置 redirect_uri 白名单） */
export function redirectUriFor(host: string): string {
  if (host === VISITOR_HOSTNAME) return `https://${VISITOR_HOSTNAME}/login/callback`;
  if (host === APPLEID_HOSTNAME) return `https://${APPLEID_HOSTNAME}/login/callback`;
  return `${BASE_URL}/login/callback`;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(input))) as T;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "") || value;
}

function normalizeGroups(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

function oidcBase(env: Env): string {
  return stripTrailingSlash(env.AUTHENTIK_URL || IDENTITY_URL);
}

function jwksUrl(env: Env): string {
  if (env.AUTHENTIK_JWKS_URL) return env.AUTHENTIK_JWKS_URL;
  return `${oidcBase(env)}/application/o/${AUTHENTIK_PROVIDER_SLUG}/jwks/`;
}

function userInfoUrl(env: Env): string {
  return `${oidcBase(env)}/application/o/userinfo/`;
}

/** 配置错误只返回字段名，绝不返回密钥值。 */
export function oidcConfigError(env: Env): string | null {
  const missing: string[] = [];
  if (!env.AUTHENTIK_CLIENT_ID?.trim()) missing.push("AUTHENTIK_CLIENT_ID");
  if (!env.AUTHENTIK_CLIENT_SECRET?.trim()) missing.push("AUTHENTIK_CLIENT_SECRET");
  return missing.length ? `missing_${missing.join("_")}` : null;
}

export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(codeVerifier)),
  );
  return b64urlEncode(digest);
}

export function buildAuthorizeUrl(
  env: Env,
  state: string,
  redirectUri: string,
  options: { nonce: string; codeChallenge?: string },
): string {
  const params = new URLSearchParams({
    client_id: env.AUTHENTIK_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid profile email groups",
    state,
    nonce: options.nonce,
  });
  if (env.AUTHENTIK_PKCE_ENABLED !== "false" && options.codeChallenge) {
    params.set("code_challenge", options.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${oidcBase(env)}/application/o/authorize/?${params.toString()}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeReason(value: string): string {
  return value.slice(0, 200);
}

async function fetchJwks(env: Env): Promise<{ keys: JwkLike[] } | { error: string }> {
  try {
    const resp = await fetchWithTimeout(
      jwksUrl(env),
      { headers: { Accept: "application/json", "User-Agent": OIDC_USER_AGENT } },
      JWKS_TIMEOUT_MS,
    );
    if (!resp.ok) return { error: `jwks_http_${resp.status}` };
    const data = (await resp.json()) as { keys?: JwkLike[] };
    if (!Array.isArray(data.keys) || !data.keys.length) return { error: "jwks_empty" };
    return { keys: data.keys };
  } catch {
    return { error: "jwks_fetch_exception" };
  }
}

function selectJwk(header: JwtHeader, keys: JwkLike[], alg: string): JwkLike | undefined {
  if (header.kid) return keys.find((key) => key.kid === header.kid);
  return keys.find((key) => {
    if (alg === "RS256") return key.kty === "RSA";
    return key.kty === "EC";
  });
}

async function verifyJwtSignature(
  header: JwtHeader,
  signingInput: string,
  signature: Uint8Array,
  key: JwkLike,
  alg: string,
): Promise<boolean> {
  try {
    const signatureBytes = new Uint8Array(
      signature.buffer as ArrayBuffer,
      signature.byteOffset,
      signature.byteLength,
    );
    const signingBytes = new Uint8Array(
      textEncoder.encode(signingInput).buffer as ArrayBuffer,
      textEncoder.encode(signingInput).byteOffset,
      textEncoder.encode(signingInput).byteLength,
    );
    if (alg === "RS256") {
      if (key.kty !== "RSA" || !key.n || !key.e) return false;
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: key.n, e: key.e, alg: "RS256" },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        cryptoKey,
        signatureBytes,
        signingBytes,
      );
    }

    if (alg === "ES256") {
      if (key.kty !== "EC" || !key.x || !key.y) return false;
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: key.crv || "P-256", x: key.x, y: key.y, alg: "ES256" },
        { name: "ECDSA", namedCurve: key.crv || "P-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        signatureBytes,
        signingBytes,
      );
    }
    return false;
  } catch {
    return false;
  }
}

function validateClaims(
  claims: IdTokenClaims,
  env: Env,
  expectedNonce: string | undefined,
  requireBackchannelEvent = false,
): string | null {
  if (!claims || typeof claims !== "object") return "id_token_no_claims";
  if (!claims.sub || typeof claims.sub !== "string") return "id_token_no_sub";

  const expectedIssuer = oidcBase(env);
  const actualIssuer = typeof claims.iss === "string" ? stripTrailingSlash(claims.iss) : "";
  if (!actualIssuer || actualIssuer !== expectedIssuer) return "id_token_issuer_mismatch";

  const audiences =
    typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!audiences.includes(env.AUTHENTIK_CLIENT_ID ?? "")) return "id_token_aud_mismatch";

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return "id_token_expired";
  if (typeof claims.iat !== "number") return "id_token_missing_iat";
  if (claims.iat > now + CLOCK_SKEW_SECONDS) return "id_token_iat_invalid";
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) {
    return "id_token_nbf_invalid";
  }
  if (expectedNonce !== undefined && claims.nonce !== expectedNonce) {
    return "id_token_nonce_mismatch";
  }
  if (
    requireBackchannelEvent &&
    claims.events?.["http://schemas.openid.net/event/backchannel-logout"] == null
  ) {
    return "logout_token_event_missing";
  }
  return null;
}

async function verifyJwt(
  env: Env,
  token: string,
  options: { expectedNonce?: string; requireBackchannelEvent?: boolean },
): Promise<OidcTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "jwt_format" };

  let header: JwtHeader;
  let claims: IdTokenClaims;
  try {
    header = decodeJson<JwtHeader>(parts[0]);
  } catch {
    return { ok: false, reason: "jwt_header_parse" };
  }
  const alg = header.alg ?? "";
  if (alg === "none" || !["RS256", "ES256"].includes(alg)) {
    return { ok: false, reason: `jwt_alg_unsupported:${alg === "none" ? "none" : alg}` };
  }

  const jwks = await fetchJwks(env);
  if ("error" in jwks) return { ok: false, reason: jwks.error };
  const key = selectJwk(header, jwks.keys, alg);
  if (!key) return { ok: false, reason: "jwt_kid_missing" };

  const signature = b64urlDecode(parts[2]);
  const signingInput = `${parts[0]}.${parts[1]}`;
  if (!(await verifyJwtSignature(header, signingInput, signature, key, alg))) {
    return { ok: false, reason: "jwt_signature_invalid" };
  }
  try {
    claims = decodeJson<IdTokenClaims>(parts[1]);
  } catch {
    return { ok: false, reason: "jwt_claims_parse" };
  }
  const claimError = validateClaims(
    claims,
    env,
    options.expectedNonce,
    options.requireBackchannelEvent,
  );
  if (claimError) return { ok: false, reason: claimError };
  return { ok: true, claims };
}

export async function verifyIdToken(
  env: Env,
  token: string,
  expectedNonce: string,
): Promise<OidcTokenResult> {
  return verifyJwt(env, token, { expectedNonce });
}

export async function verifyBackchannelLogout(
  env: Env,
  token: string,
): Promise<OidcTokenResult> {
  return verifyJwt(env, token, { requireBackchannelEvent: true });
}

async function fetchUserInfo(
  env: Env,
  accessToken: string | undefined,
): Promise<{ ok: true; groups: string[] } | { ok: false; reason: string }> {
  if (!accessToken) return { ok: false, reason: "userinfo_no_access_token" };
  try {
    const resp = await fetchWithTimeout(
      userInfoUrl(env),
      {
        headers: {
          Accept: "application/json",
          "User-Agent": OIDC_USER_AGENT,
          Authorization: `Bearer ${accessToken}`,
        },
      },
      USERINFO_TIMEOUT_MS,
    );
    if (!resp.ok) return { ok: false, reason: `userinfo_http_${resp.status}` };
    const data = (await resp.json()) as { groups?: unknown };
    return { ok: true, groups: normalizeGroups(data.groups) ?? [] };
  } catch {
    return { ok: false, reason: "userinfo_fetch_exception" };
  }
}

export async function exchangeCode(
  env: Env,
  code: string,
  redirectUri: string,
  options: OidcExchangeOptions,
): Promise<OidcExchangeResult> {
  const configError = oidcConfigError(env);
  if (configError) return { reason: configError };

  const body = new URLSearchParams({
    client_id: env.AUTHENTIK_CLIENT_ID ?? "",
    client_secret: env.AUTHENTIK_CLIENT_SECRET ?? "",
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (env.AUTHENTIK_PKCE_ENABLED !== "false" && options.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  let token: TokenResponse | null = null;
  let reason = "";
  try {
    const resp = await fetchWithTimeout(
      `${oidcBase(env)}/application/o/token/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // nginx 的 $ua_deny 只放行含 Mozilla 的 UA，服务端 token 交换必须带浏览器 UA
          "User-Agent": OIDC_USER_AGENT,
        },
        body: body.toString(),
      },
      TOKEN_TIMEOUT_MS,
    );
    const text = await resp.text();
    try {
      token = JSON.parse(text) as TokenResponse;
    } catch {
      reason = `bad_json:${safeReason(text)}`;
    }
    if (!resp.ok) {
      reason = reason || `http_${resp.status}:${safeReason(token?.error_description || token?.error || text)}`;
    } else if (!token?.id_token) {
      reason = reason || "no_id_token";
    }
  } catch {
    reason = "fetch_exception";
  }
  if (!token?.id_token) return { reason: reason || "no_id_token" };

  const verified = await verifyIdToken(env, token.id_token, options.nonce);
  if (!verified.ok) return { reason: verified.reason };

  let groups = normalizeGroups(verified.claims.groups) ?? [];
  if (!groups.length) {
    const userInfo = await fetchUserInfo(env, token.access_token);
    if (!userInfo.ok) return { reason: userInfo.reason };
    groups = userInfo.groups;
  }

  const adminGroups = (env.AUTHENTIK_ADMIN_GROUPS || AUTHENTIK_ADMIN_GROUPS_DEFAULT)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const email = verified.claims.preferred_username || verified.claims.email || "";
  const name = verified.claims.name || email;

  return {
    session: {
      sub: verified.claims.sub ?? "",
      user: { email, name },
      role: groups.some((g) => adminGroups.includes(g)) ? "admin" : "viewer",
      authAt: Math.floor(Date.now() / 1000),
    },
  };
}

export function buildLogoutUrl(env: Env, nextUrl: string): string {
  const params = new URLSearchParams({ post_logout_redirect_uri: nextUrl });
  return `${oidcBase(env)}/application/o/${AUTHENTIK_PROVIDER_SLUG}/end-session/?${params.toString()}`;
}
