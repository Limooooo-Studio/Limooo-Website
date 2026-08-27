/** CSRF 双提交保护测试；不读取真实密钥。 */

import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { createCsrfToken, csrfCookieHeader, verifyCsrf } from "./csrf";

const env = {
  SESSION_HMAC_KEY: "csrf-test-secret",
  GATE_HMAC_KEY: "csrf-test-gate",
} as Env;

function request(
  origin: string,
  token: string,
  cookieToken = token,
  method = "POST",
): Request {
  return new Request("https://appleid.limooo.cn/api/appleid/accounts/1/reveal", {
    method,
    headers: {
      Origin: origin,
      "X-CSRF-Token": token,
      Cookie: `limooo_csrf=${cookieToken}`,
    },
  });
}

describe("csrf", () => {
  it("round-trips a signed token with matching cookie and header", async () => {
    const { token } = await createCsrfToken(env);
    expect(await verifyCsrf(env, request("https://appleid.limooo.cn", token))).toBe(true);
  });

  it("rejects missing or mismatched header/cookie", async () => {
    const { token } = await createCsrfToken(env);
    expect(await verifyCsrf(env, request("https://appleid.limooo.cn", "", token))).toBe(false);
    expect(await verifyCsrf(env, request("https://appleid.limooo.cn", token, "different"))).toBe(false);
  });

  it("rejects cross-site origins", async () => {
    const { token } = await createCsrfToken(env);
    expect(await verifyCsrf(env, request("https://evil.example", token))).toBe(false);
  });

  it("allows localhost and 127.0.0.1 origins", async () => {
    const { token } = await createCsrfToken(env);
    expect(await verifyCsrf(env, request("http://localhost:8788", token))).toBe(true);
    expect(await verifyCsrf(env, request("http://127.0.0.1:8080", token))).toBe(true);
  });

  it("cookie header is not HttpOnly and can be read by JavaScript", () => {
    const header = csrfCookieHeader("token", true);
    expect(header).not.toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
  });
});
