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
  APPLE_ACCOUNT_HOSTNAME,
  CSRF_COOKIE,
  VISITOR_HOSTNAME,
} from "./config";
import type { Env } from "./env";
import { getCookie } from "./routing";
import { hmacSha256Hex, timingSafeEqual, toB64Url } from "./crypto";

export const CSRF_HEADER_NAME = "X-CSRF-Token";
export const CSRF_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

const PROD_ORIGINS = new Set([
  `https://${VISITOR_HOSTNAME}`,
  `https://${APPLE_ACCOUNT_HOSTNAME}`,
]);
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

function csrfSecret(env: Env): string {
  return env.SESSION_HMAC_KEY || env.GATE_HMAC_KEY || "";
}

async function validToken(token: string, secret: string): Promise<boolean> {
  if (!secret || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(signature, await hmacSha256Hex(secret, payload));
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
  return { token: `${payload}.${await hmacSha256Hex(secret, payload)}` };
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
