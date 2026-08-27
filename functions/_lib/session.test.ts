/** HMAC 会话 cookie + D1 会话撤销表单元测试 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { execute, queryAll } from "./d1";
import {
  AuthSessionUnavailableError,
  configErrorResponse,
  createAuthSession,
  createPendingCookie,
  createSessionCookie,
  readPending,
  readSession,
  requireAuth,
  revokeAuthSession,
  revokeAuthSessionsBySub,
  runtimeConfigError,
} from "./session";

vi.mock("./d1", () => ({
  execute: vi.fn(),
  queryAll: vi.fn(),
}));

const env: Env = {
  DB: {},
  SESSION_HMAC_KEY: "test-session-hmac-key",
} as Env;

function sessionData(prefix = ""): any {
  return {
    sid: `${prefix}sid-1`,
    sub: "user-1",
    user: { email: "a@example.com", name: "A" },
    role: "admin",
    authAt: 1,
  };
}

function requestWith(cookie: string): Request {
  return new Request("https://visitor.limooo.cn/api", {
    headers: { Cookie: cookie },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(queryAll).mockResolvedValue([]);
});

describe("session cookie", () => {
  it("round-trips a valid session with sid and cross-subdomain domain", async () => {
    const header = await createSessionCookie(env, sessionData());
    expect(header).toContain("Domain=.limooo.cn");
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    const session = await readSession(env, header);
    expect(session?.sid).toBe("sid-1");
    expect(session?.sub).toBe("user-1");
    expect(session?.role).toBe("admin");
  });

  it("rejects tampered tokens", async () => {
    const header = await createSessionCookie(env, sessionData());
    const dot = header.lastIndexOf(".");
    const originalPayload = header.slice(header.indexOf("=") + 1, dot);
    const decoded = Buffer.from(originalPayload, "base64url").toString();
    const tamperedPayload = Buffer.from(decoded.replace("user-1", "user-2")).toString("base64url");
    const tampered = header.replace(originalPayload, tamperedPayload);
    expect(await readSession(env, tampered)).toBeNull();
  });

  it("rejects malformed session payloads", async () => {
    const header = await createSessionCookie(env, sessionData());
    const dot = header.lastIndexOf(".");
    const originalPayload = header.slice(header.indexOf("=") + 1, dot);
    const decoded = Buffer.from(originalPayload, "base64url").toString();
    const badPayload = Buffer.from(decoded.replace('"sid":"sid-1"', '"sid":""')).toString("base64url");
    const tampered = header.replace(originalPayload, badPayload);
    expect(await readSession(env, tampered)).toBeNull();
  });
});

describe("pending cookie", () => {
  it("round-trips state, nonce, code verifier and next", async () => {
    const header = await createPendingCookie(env, {
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      next: "/visitor",
    });
    const pending = await readPending(env, header);
    expect(pending).toEqual({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      next: "/visitor",
    });
  });
});

describe("auth_sessions revoke table", () => {
  it("checks the D1 record before allowing requireAuth", async () => {
    const header = await createSessionCookie(env, sessionData());
    vi.mocked(queryAll).mockResolvedValue([{
      sid: "sid-1",
      sub: "user-1",
      role: "admin",
      auth_at: 1,
      exp: Math.floor(Date.now() / 1000) + 300,
      revoked_at: null,
    }]);
    const session = await requireAuth(env, requestWith(header));
    expect(session?.sid).toBe("sid-1");
    expect(vi.mocked(queryAll).mock.calls[0][1]).toContain("FROM auth_sessions");
  });

  it("does not allow a revoked session", async () => {
    const header = await createSessionCookie(env, sessionData());
    vi.mocked(queryAll).mockResolvedValue([{
      sid: "sid-1",
      sub: "user-1",
      role: "admin",
      auth_at: 1,
      exp: Math.floor(Date.now() / 1000) + 300,
      revoked_at: 123,
    }]);
    const session = await requireAuth(env, requestWith(header));
    expect(session).toBeNull();
  });

  it("throws AuthSessionUnavailableError when D1 is unavailable", async () => {
    const header = await createSessionCookie(env, sessionData());
    await expect(requireAuth({ SESSION_HMAC_KEY: env.SESSION_HMAC_KEY } as Env, requestWith(header)))
      .rejects.toBeInstanceOf(AuthSessionUnavailableError);
  });

  it("creates and revokes sessions", async () => {
    expect(await createAuthSession(env, sessionData())).toBe(true);
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("INSERT INTO auth_sessions");

    vi.mocked(execute).mockClear();
    expect(await revokeAuthSession(env, "sid-1")).toBe(true);
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("SET revoked_at = unixepoch()");

    vi.mocked(execute).mockClear();
    expect(await revokeAuthSessionsBySub(env, "user-1")).toBe(true);
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("WHERE sub = ?");
  });
});

describe("runtime config", () => {
  it("returns a config error for missing secrets", () => {
    expect(runtimeConfigError({} as Env)).toContain("TURNSTILE_SECRET");
    expect(runtimeConfigError({
      TURNSTILE_SECRET: "x",
      GATE_HMAC_KEY: "x",
      SESSION_HMAC_KEY: "x",
    } as Env)).toBeNull();
  });

  it("renders a no-store 503 config page", () => {
    const resp = configErrorResponse("missing_SESSION_HMAC_KEY");
    expect(resp.status).toBe(503);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });
});
