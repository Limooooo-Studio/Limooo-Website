/** 自研 HMAC 签名会话 cookie + D1 auth_sessions 撤销表（Pages 无内置 session） */

import { execute, queryAll } from "./d1";
import type { Env } from "./env";
import {
  PENDING_COOKIE,
  PENDING_TTL_SECONDS,
  ROOT_DOMAIN,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./config";

const textEncoder = new TextEncoder();
const COOKIE_DOMAIN = `.${ROOT_DOMAIN}`;
const AUTH_SESSION_TABLE = "auth_sessions";

export interface SessionUser {
  email: string;
  name: string;
}

export interface SessionData {
  sid: string;
  sub: string;
  user: SessionUser;
  role: "admin" | "viewer";
  authAt: number;
}

interface SignedSession extends SessionData {
  exp: number;
}

export interface PendingData {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
}

interface SignedPending extends PendingData {
  exp: number;
}

interface AuthSessionRow {
  sid: string;
  sub: string;
  role: "admin" | "viewer";
  auth_at: number;
  exp: number;
  revoked_at: number | null;
}

export class AuthSessionUnavailableError extends Error {
  constructor(message = "auth_sessions_unavailable") {
    super(message);
    this.name = "AuthSessionUnavailableError";
  }
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function hmacHex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(name: string, header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function signPayload(key: string, payload: string): Promise<string> {
  return `${toB64Url(textEncoder.encode(payload))}.${await hmacHex(key, payload)}`;
}

async function verifyPayload<T>(key: string, token: string | undefined): Promise<T | null> {
  if (!key || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(key, new TextDecoder().decode(fromB64Url(b64)));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64Url(b64))) as T;
  } catch {
    return null;
  }
}

function cookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Domain=${COOKIE_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookieHeader(name: string): string {
  return `${name}=; Domain=${COOKIE_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64Url(value);
}

export async function createSessionCookie(env: Env, data: SessionData): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload: SignedSession = { ...data, exp };
  return cookieHeader(SESSION_COOKIE, await signPayload(env.SESSION_HMAC_KEY ?? "", JSON.stringify(payload)), SESSION_TTL_SECONDS);
}

export function clearSessionCookie(): string {
  return clearCookieHeader(SESSION_COOKIE);
}

export async function readSession(
  env: Env,
  cookieHeaderValue: string | null,
): Promise<SessionData | null> {
  const token = getCookie(SESSION_COOKIE, cookieHeaderValue);
  const data = await verifyPayload<SignedSession>(env.SESSION_HMAC_KEY ?? "", token);
  if (!data) return null;
  if (
    typeof data.exp !== "number" ||
    data.exp < Math.floor(Date.now() / 1000) ||
    typeof data.sid !== "string" ||
    typeof data.sub !== "string" ||
    !data.user ||
    typeof data.user.email !== "string" ||
    typeof data.user.name !== "string" ||
    !["admin", "viewer"].includes(data.role) ||
    typeof data.authAt !== "number"
  ) {
    return null;
  }
  return {
    sid: data.sid,
    sub: data.sub,
    user: { email: data.user.email, name: data.user.name },
    role: data.role,
    authAt: data.authAt,
  };
}

/**
 * 校验签名 cookie 后必须再查 D1 auth_sessions。表不存在或查不到时按
 * AuthSessionUnavailableError 抛出，由调用方返回 503，不能 fallback 到
 * 仅凭签名 cookie 放行。
 */
export async function requireAuth(env: Env, request: Request): Promise<SessionData | null> {
  const session = await readSession(env, request.headers.get("Cookie"));
  if (!session) return null;
  if (!env.DB) throw new AuthSessionUnavailableError();

  try {
    const rows = await queryAll<AuthSessionRow>(
      env.DB,
      `SELECT sid, sub, role, auth_at, exp, revoked_at
       FROM ${AUTH_SESSION_TABLE}
       WHERE sid = ? AND sub = ?`,
      session.sid,
      session.sub,
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (row.revoked_at != null) return null;
    if (Number(row.exp) <= Math.floor(Date.now() / 1000)) return null;
    if (row.sub !== session.sub || row.role !== session.role) return null;
    return session;
  } catch (error) {
    if (error instanceof AuthSessionUnavailableError) throw error;
    throw new AuthSessionUnavailableError(
      error instanceof Error ? error.message : "auth_sessions_unavailable",
    );
  }
}

export async function createAuthSession(env: Env, session: SessionData): Promise<boolean> {
  if (!env.DB || !session.sid || !session.sub) return false;
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  try {
    return await execute(
      env.DB,
      `INSERT INTO ${AUTH_SESSION_TABLE}
        (sid, sub, role, auth_at, exp, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      session.sid,
      session.sub,
      session.role,
      session.authAt,
      exp,
    );
  } catch {
    return false;
  }
}

export async function revokeAuthSession(env: Env, sid: string): Promise<boolean> {
  if (!env.DB || !sid) return false;
  try {
    return await execute(
      env.DB,
      `UPDATE ${AUTH_SESSION_TABLE}
       SET revoked_at = unixepoch()
       WHERE sid = ? AND revoked_at IS NULL`,
      sid,
    );
  } catch {
    return false;
  }
}

export async function revokeAuthSessionsBySub(env: Env, sub: string): Promise<boolean> {
  if (!env.DB || !sub) return false;
  try {
    return await execute(
      env.DB,
      `UPDATE ${AUTH_SESSION_TABLE}
       SET revoked_at = unixepoch()
       WHERE sub = ? AND revoked_at IS NULL AND exp > unixepoch()`,
      sub,
    );
  } catch {
    return false;
  }
}

export async function createPendingCookie(env: Env, pending: PendingData): Promise<string> {
  const payload: SignedPending = {
    ...pending,
    exp: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS,
  };
  return cookieHeader(PENDING_COOKIE, await signPayload(env.SESSION_HMAC_KEY ?? "", JSON.stringify(payload)), PENDING_TTL_SECONDS);
}

export async function readPending(
  env: Env,
  cookieHeaderValue: string | null,
): Promise<PendingData | null> {
  const token = getCookie(PENDING_COOKIE, cookieHeaderValue);
  const data = await verifyPayload<SignedPending>(env.SESSION_HMAC_KEY ?? "", token);
  if (!data) return null;
  if (
    typeof data.exp !== "number" ||
    data.exp < Math.floor(Date.now() / 1000) ||
    !data.state ||
    !data.nonce ||
    !data.codeVerifier ||
    !data.next
  ) {
    return null;
  }
  return {
    state: data.state,
    nonce: data.nonce,
    codeVerifier: data.codeVerifier,
    next: data.next,
  };
}

export function clearPendingCookie(): string {
  return clearCookieHeader(PENDING_COOKIE);
}

/** 门禁/会话运行必需的密钥；只返回字段名，不回显值。 */
export function runtimeConfigError(env: Env): string | null {
  const missing: string[] = [];
  if (!env.TURNSTILE_SECRET?.trim()) missing.push("TURNSTILE_SECRET");
  if (!env.GATE_HMAC_KEY?.trim()) missing.push("GATE_HMAC_KEY");
  if (!env.SESSION_HMAC_KEY?.trim()) missing.push("SESSION_HMAC_KEY");
  return missing.length ? `missing_${missing.join("_")}` : null;
}

export function configErrorResponse(reason: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>503</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem">
  <h1>503 Service Configuration Error</h1>
  <p>Service configuration is incomplete. Please contact the administrator.</p>
  <p hidden data-reason="${reason.replace(/"/g, "&quot;")}"></p>
</body>
</html>`;
  return new Response(body, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function authUnavailableResponse(): Response {
  return Response.json(
    { error: "auth_sessions_unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
