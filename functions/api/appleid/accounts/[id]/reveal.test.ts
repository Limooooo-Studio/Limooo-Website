/** Apple ID 明文 reveal 接口测试：admin-only、CSRF、审计、无明文回退。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPost } from "./reveal";
import { queryAll } from "../../../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../../../_lib/session";
import { verifyCsrf } from "../../../../_lib/csrf";
import { fernetDecrypt } from "../../../../_lib/fernet";
import { logEvent } from "../../../../_lib/logging";
import type { Env } from "../../../../_lib/env";

vi.mock("../../../../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../../../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(),
}));
vi.mock("../../../../_lib/csrf", () => ({ verifyCsrf: vi.fn() }));
vi.mock("../../../../_lib/fernet", () => ({ fernetDecrypt: vi.fn() }));
vi.mock("../../../../_lib/logging", () => ({ logEvent: vi.fn() }));

const env = { APPLEID_ENCRYPTION_KEY: "test-key" } as Env;

function context() {
  return {
    request: new Request("https://appleid.limooo.cn/api/appleid/accounts/1/reveal", {
      method: "POST",
      headers: {
        Origin: "https://appleid.limooo.cn",
        "X-CSRF-Token": "valid",
      },
    }),
    env,
    params: { id: "1" },
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({
    sid: "sid-1",
    sub: "user-1",
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin",
    authAt: 1,
  } as never);
  vi.mocked(authUnavailableResponse).mockReturnValue(
    Response.json({ error: "auth_sessions_unavailable" }, { status: 503 }),
  );
  vi.mocked(verifyCsrf).mockResolvedValue(true);
  vi.mocked(fernetDecrypt).mockResolvedValue("plain-password");
  vi.mocked(queryAll).mockResolvedValue([{ password: "cipher" }]);
  vi.mocked(logEvent).mockResolvedValue();
});

describe("appleid reveal API", () => {
  it("returns 401/403 before touching data", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    expect((await onRequestPost(context() as never)).status).toBe(401);
    vi.mocked(requireAuth).mockResolvedValue({
      sid: "sid-1",
      sub: "user-1",
      user: { email: "viewer@example.com", name: "Viewer" },
      role: "viewer",
      authAt: 1,
    } as never);
    expect((await onRequestPost(context() as never)).status).toBe(403);
  });

  it("returns 403 when CSRF is missing", async () => {
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    expect((await onRequestPost(context() as never)).status).toBe(403);
  });

  it("reveals to admin and writes an audit event", async () => {
    const resp = await onRequestPost(context() as never);
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.password).toBe("plain-password");
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      env,
      "audit_event",
      expect.any(Request),
      expect.objectContaining({
        accountId: 1,
        actorSub: "user-1",
        outcome: "password_revealed",
      }),
    );
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never returns plaintext when decryption fails, and audits the failure", async () => {
    vi.mocked(fernetDecrypt).mockRejectedValue(new Error("bad token"));
    const resp = await onRequestPost(context() as never);
    const body = await resp.text();
    expect(resp.status).toBe(500);
    expect(body).not.toContain("plain-password");
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      env,
      "audit_event",
      expect.any(Request),
      expect.objectContaining({ outcome: "decrypt_failed" }),
    );
  });
});
