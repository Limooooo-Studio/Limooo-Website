/** 敏感 API 的同步双提交 CSRF 保护。
 *
 * 采用“签名随机值 + 双提交”方案：
 * - 服务端签发随机 token，写入非 HttpOnly cookie（前端需要读取），
 *   同时在响应头返回同一 token；前端写入 X-CSRF-Token。
 * - 服务端校验 cookie 与 header 完全一致，并用 SESSION_HMAC_KEY（或
 *   GATE_HMAC_KEY）验证签名，防止第三方子域自行种值伪造。
 * - 写请求同时必须携带可信 Origin；跨站请求无自定义头且无法读取 cookie，
 *   因此不能通过简单表单提交。
 */

import {
  APPLEID_HOSTNAME,
  CSRF_COOKIE,
  VISITOR_HOSTNAME,
} from "./config";
import type { Env } from "./env";

export const CSRF_HEADER_NAME = "X-CSRF-Token";
export const CSRF_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

const textEncoder = new TextEncoder();
const PROD_ORIGINS = new Set([
  `https://${VISITOR_HOSTNAME}`,
  `https://${APPLEID_HOSTNAME}`,
]);
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacHex(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(value))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function csrfSecret(env: Env): string {
  return env.SESSION_HMAC_KEY || env.GATE_HMAC_KEY || "";
}

function getCookie(name: string, header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return undefined;
}

async function validToken(token: string, secret: string): Promise<boolean> {
  if (!secret || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = await hmacHex(secret, payload);
  return timingSafeEqual(signature, expected);
}

function isAllowedOrigin(origin: string): boolean {
  const normalized = origin.replace(/\/+$/, "");
  if (PROD_ORIGINS.has(normalized)) return true;
  return LOCAL_ORIGIN_RE.test(normalized);
}

/** 签发一次 CSRF token；cookie 不能设为 HttpOnly，前端需要读取后放到请求头。 */
export async function createCsrfToken(env: Env): Promise<{ token: string }> {
  const secret = csrfSecret(env);
  if (!secret) throw new Error("CSRF secret is not configured");
  const payload = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token: `${payload}.${await hmacHex(secret, payload)}` };
}

export function csrfCookieHeader(token: string, secure = true): string {
  return `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${CSRF_COOKIE_MAX_AGE}; SameSite=Lax; ${secure ? "Secure; " : ""}`;
}

/** 校验写请求：Origin 可信 + cookie/header 双提交一致 + 服务端签名有效。 */
export async function verifyCsrf(env: Env, request: Request): Promise<boolean> {
  const origin = request.headers.get("Origin") ?? "";
  if (!isAllowedOrigin(origin)) return false;
  const header = request.headers.get(CSRF_HEADER_NAME) ?? "";
  const cookie = getCookie(CSRF_COOKIE, request.headers.get("Cookie")) ?? "";
  if (!header || header !== cookie) return false;
  return validToken(header, csrfSecret(env));
}
