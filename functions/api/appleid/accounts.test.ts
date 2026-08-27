/** Apple ID 列表与新增接口测试（mock 所有外部依赖）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet, onRequestPost } from "./accounts";
import { execute, queryAll } from "../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../_lib/session";
import { verifyCsrf } from "../../_lib/csrf";
import { fernetEncrypt } from "../../_lib/fernet";
import type { Env } from "../../_lib/env";

vi.mock("../../_lib/d1", () => ({ queryAll: vi.fn(), execute: vi.fn() }));
vi.mock("../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(),
}));
vi.mock("../../_lib/csrf", () => ({ verifyCsrf: vi.fn() }));
vi.mock("../../_lib/fernet", () => ({ fernetEncrypt: vi.fn() }));

const env = {
  APPLEID_ENCRYPTION_KEY: "test-key",
} as Env;

function context(request: Request) {
  return {
    request,
    env,
    params: {},
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

function appleidRequest(method: string, body?: unknown): Request {
  return new Request("https://appleid.limooo.cn/api/appleid/accounts", {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "https://appleid.limooo.cn",
      "X-CSRF-Token": "valid",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  vi.mocked(fernetEncrypt).mockResolvedValue("encrypted");
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(queryAll).mockResolvedValue([]);
});

describe("appleid accounts API", () => {
  it("returns a masked password and never a plaintext field", async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      sid: "sid-1",
      sub: "user-1",
      user: { email: "viewer@example.com", name: "Viewer" },
      role: "viewer",
      authAt: 1,
    } as never);
    vi.mocked(queryAll).mockResolvedValueOnce([
      { id: 1, email: "a@appleid.limooo.cn", password: "cipher", notes: "", sort_order: 0 },
    ]);
    const resp = await onRequestGet(context(new Request("https://appleid.limooo.cn/api/appleid/accounts")) as never);
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data[0].password).toBe("·".repeat(12));
    expect(data[0]).not.toHaveProperty("plain");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 401 when unauthenticated and 403 for viewers on POST", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const unauth = await onRequestPost(
      context(appleidRequest("POST", { email: "a", password: "p", notes: "" })) as never,
    );
    expect(unauth.status).toBe(401);

    vi.mocked(requireAuth).mockResolvedValue({
      sid: "sid-1",
      sub: "user-1",
      user: { email: "viewer@example.com", name: "Viewer" },
      role: "viewer",
      authAt: 1,
    } as never);
    const viewer = await onRequestPost(
      context(appleidRequest("POST", { email: "a", password: "p", notes: "" })) as never,
    );
    expect(viewer.status).toBe(403);
  });

  it("rejects a missing CSRF token", async () => {
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    const resp = await onRequestPost(
      context(appleidRequest("POST", { email: "a", password: "p", notes: "" })) as never,
    );
    expect(resp.status).toBe(403);
  });

  it("rejects unknown fields and invalid payloads", async () => {
    const unknown = await onRequestPost(
      context(appleidRequest("POST", { email: "a", password: "p", notes: "", extra: 1 })) as never,
    );
    expect(unknown.status).toBe(400);
    const invalid = await onRequestPost(
      context(appleidRequest("POST", { email: "", password: "p", notes: "" })) as never,
    );
    expect(invalid.status).toBe(400);
  });

  it("creates an account for a valid admin request", async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([{ n: 2 }]);
    const resp = await onRequestPost(
      context(appleidRequest("POST", { email: "alice", password: "secret", notes: "note" })) as never,
    );
    expect(resp.status).toBe(200);
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      env.DB,
      expect.stringContaining("INSERT INTO apple_accounts"),
      "alice@appleid.limooo.cn",
      "encrypted",
      "note",
      2,
    );
  });

  it("does not write without an encryption key", async () => {
    delete env.APPLEID_ENCRYPTION_KEY;
    const resp = await onRequestPost(
      context(appleidRequest("POST", { email: "alice", password: "secret", notes: "" })) as never,
    );
    expect(resp.status).toBe(500);
    env.APPLEID_ENCRYPTION_KEY = "test-key";
  });
});
