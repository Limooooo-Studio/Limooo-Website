/** /api/auth/status 的 CSRF 签发测试。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./status";
import { authUnavailableResponse, requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

vi.mock("../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(),
}));

const env = { SESSION_HMAC_KEY: "test-session" } as Env;

function context() {
  return {
    request: new Request("https://appleid.limooo.cn/api/auth/status"),
    env,
    params: {},
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(null);
  vi.mocked(authUnavailableResponse).mockReturnValue(
    Response.json({ error: "auth_sessions_unavailable" }, { status: 503 }),
  );
});

describe("auth status", () => {
  it("does not issue CSRF when unauthenticated", async () => {
    const resp = await onRequestGet(context() as never);
    expect(resp.status).toBe(200);
    expect((await resp.json()).authed).toBe(false);
    expect(resp.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("issues a readable CSRF cookie and header for authenticated admins", async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      sid: "sid-1",
      sub: "user-1",
      user: { email: "admin@example.com", name: "Admin" },
      role: "admin",
      authAt: 1,
    } as never);
    const resp = await onRequestGet(context() as never);
    const data = await resp.json();
    expect(data.authed).toBe(true);
    expect(data.role).toBe("admin");
    expect(typeof data.csrf_token).toBe("string");
    expect(resp.headers.get("X-CSRF-Token")).toBe(data.csrf_token);
    expect(resp.headers.get("Set-Cookie")).toContain("limooo_csrf=");
    expect(resp.headers.get("Set-Cookie")).not.toContain("HttpOnly");
  });
});
