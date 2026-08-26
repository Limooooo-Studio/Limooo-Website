/** HMAC 会话 cookie 单元测试（使用 Node 内置 WebCrypto，不依赖真实密钥）。 */

import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import {
  createPendingCookie,
  createSessionCookie,
  readPending,
  readSession,
} from "./session";

const env: Env = {
  SESSION_HMAC_KEY: "test-session-hmac-key",
} as Env;

describe("session cookie", () => {
  it("round-trips a valid session", async () => {
    const header = await createSessionCookie(env, {
      sub: "user-1",
      user: { email: "a@example.com", name: "A" },
      role: "admin",
      authAt: 1,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const session = await readSession(env, header);
    expect(session?.sub).toBe("user-1");
    expect(session?.role).toBe("admin");
  });

  it("rejects tampered tokens", async () => {
    const header = await createSessionCookie(env, {
      sub: "user-1",
      user: { email: "a@example.com", name: "A" },
      role: "viewer",
      authAt: 1,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const dot = header.lastIndexOf(".");
    const originalPayload = header.slice(header.indexOf("=") + 1, dot);
    const decoded = Buffer.from(originalPayload, "base64url").toString();
    const tamperedPayload = Buffer.from(decoded.replace("user-1", "user-2")).toString("base64url");
    const tampered = header.replace(originalPayload, tamperedPayload);
    expect(await readSession(env, tampered)).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const header = await createSessionCookie(env, {
      sub: "user-1",
      user: { email: "a@example.com", name: "A" },
      role: "viewer",
      authAt: 1,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect(await readSession(env, header)).toBeNull();
  });
});

describe("pending cookie", () => {
  it("round-trips pending state", async () => {
    const header = await createPendingCookie(env, "state-1", "/visitor");
    const pending = await readPending(env, header);
    expect(pending).toEqual({ state: "state-1", next: "/visitor" });
  });
});
