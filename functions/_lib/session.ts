/** 自研 HMAC 签名会话 cookie（Pages 无内置 session） */

import type { Env } from "./env";
import {
  PENDING_COOKIE,
  PENDING_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./config";

export interface SessionUser {
  email: string;
  name: string;
}

export interface SessionData {
  sub: string;
  user: SessionUser;
  role: "admin" | "viewer";
  authAt: number;
  exp: number;
}

const enc = new TextEncoder();

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
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data))));
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
  return `${toB64Url(enc.encode(payload))}.${await hmacHex(key, payload)}`;
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
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export async function createSessionCookie(env: Env, data: SessionData): Promise<string> {
  const payload = JSON.stringify({ ...data, exp: data.exp || Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
  return cookieHeader(SESSION_COOKIE, await signPayload(env.SESSION_HMAC_KEY ?? "", payload), SESSION_TTL_SECONDS);
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function readSession(env: Env, cookieHeaderValue: string | null): Promise<SessionData | null> {
  const token = getCookie(SESSION_COOKIE, cookieHeaderValue);
  const data = await verifyPayload<SessionData>(env.SESSION_HMAC_KEY ?? "", token);
  if (!data) return null;
  if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

export async function requireAuth(env: Env, request: Request): Promise<SessionData | null> {
  return readSession(env, request.headers.get("Cookie"));
}

export async function createPendingCookie(env: Env, state: string, next: string): Promise<string> {
  const payload = JSON.stringify({ state, next, exp: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS });
  return cookieHeader(PENDING_COOKIE, await signPayload(env.SESSION_HMAC_KEY ?? "", payload), PENDING_TTL_SECONDS);
}

export async function readPending(env: Env, cookieHeaderValue: string | null): Promise<{ state: string; next: string } | null> {
  const token = getCookie(PENDING_COOKIE, cookieHeaderValue);
  const data = await verifyPayload<{ state: string; next: string; exp: number }>(
    env.SESSION_HMAC_KEY ?? "",
    token,
  );
  if (!data || !data.state || !data.next) return null;
  if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
  return { state: data.state, next: data.next };
}

export function clearPendingCookie(): string {
  return `${PENDING_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
