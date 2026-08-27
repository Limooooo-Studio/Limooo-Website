/** Apple ID 更新/删除接口测试（mock 所有外部依赖）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestDelete, onRequestPut } from "./[id]";
import { execute, queryAll } from "../../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../../_lib/session";
import { verifyCsrf } from "../../../_lib/csrf";
import { fernetEncrypt } from "../../../_lib/fernet";
import type { Env } from "../../../_lib/env";

vi.mock("../../../_lib/d1", () => ({ queryAll: vi.fn(), execute: vi.fn() }));
vi.mock("../../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(),
}));
vi.mock("../../../_lib/csrf", () => ({ verifyCsrf: vi.fn() }));
vi.mock("../../../_lib/fernet", () => ({ fernetEncrypt: vi.fn() }));

const env = { APPLEID_ENCRYPTION_KEY: "test-key" } as Env;

function context(request: Request) {
  return {
    request,
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
  vi.mocked(fernetEncrypt).mockResolvedValue("encrypted");
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(queryAll).mockResolvedValue([{ id: 1 }]);
});

function request(method: string, body?: unknown): Request {
  return new Request("https://appleid.limooo.cn/api/appleid/accounts/1", {
    method,
    headers: {
      Origin: "https://appleid.limooo.cn",
      "X-CSRF-Token": "valid",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("appleid account id API", () => {
  it("updates an account with CSRF and returns 404 for missing rows", async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([{ password: "old-cipher" }]);
    const ok = await onRequestPut(
      context(request("PUT", {
        email: "alice@appleid.limooo.cn",
        password: "",
        notes: "",
        password_changed: false,
      })) as never,
    );
    expect(ok.status).toBe(200);

    vi.mocked(queryAll).mockResolvedValueOnce([]);
    const missing = await onRequestPut(
      context(request("PUT", {
        email: "alice@appleid.limooo.cn",
        password: "",
        notes: "",
        password_changed: false,
      })) as never,
    );
    expect(missing.status).toBe(404);
  });

  it("rejects a CSRF failure and invalid id", async () => {
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    const csrf = await onRequestPut(
      context(request("PUT", {
        email: "alice",
        password: "",
        notes: "",
        password_changed: false,
      })) as never,
    );
    expect(csrf.status).toBe(403);

    vi.mocked(verifyCsrf).mockResolvedValue(true);
    const badId = await onRequestDelete(
      {
        request: request("DELETE"),
        env,
        params: { id: "-1" },
        next: async () => new Response("next"),
        waitUntil: vi.fn(),
      } as never,
    );
    expect(badId.status).toBe(400);
  });

  it("deletes an existing account", async () => {
    const resp = await onRequestDelete(context(request("DELETE")) as never);
    expect(resp.status).toBe(200);
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      env.DB,
      "DELETE FROM apple_accounts WHERE id = ?",
      1,
    );
  });
});
