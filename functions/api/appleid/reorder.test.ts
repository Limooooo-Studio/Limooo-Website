/** 排序接口测试：admin、CSRF、输入集合校验、D1 batch 原子性。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPut } from "./reorder";
import { executeBatch, queryAll } from "../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../_lib/session";
import { verifyCsrf } from "../../_lib/csrf";
import type { Env } from "../../_lib/env";

vi.mock("../../_lib/d1", () => ({ queryAll: vi.fn(), executeBatch: vi.fn() }));
vi.mock("../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(),
}));
vi.mock("../../_lib/csrf", () => ({ verifyCsrf: vi.fn() }));

const prepared = {
  bind: vi.fn(() => prepared),
  run: vi.fn(),
  all: vi.fn(),
} as never;
const db = {
  prepare: vi.fn(() => prepared),
  batch: vi.fn(async () => [{ success: true }]),
} as never;
const env = { DB: db } as Env;

function context(body: unknown) {
  return {
    request: new Request("https://appleid.limooo.cn/api/appleid/reorder", {
      method: "PUT",
      headers: {
        Origin: "https://appleid.limooo.cn",
        "X-CSRF-Token": "valid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    params: {},
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
  vi.mocked(queryAll).mockResolvedValue([{ id: 1 }, { id: 2 }]);
  vi.mocked(executeBatch).mockResolvedValue(true);
});

describe("appleid reorder API", () => {
  it("updates all ids in one batch", async () => {
    const resp = await onRequestPut(context({ order: [2, 1] }) as never);
    expect(resp.status).toBe(200);
    expect(vi.mocked(executeBatch)).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate, unknown, or malformed order arrays", async () => {
    expect((await onRequestPut(context({ order: [1, 1] }) as never)).status).toBe(400);
    expect((await onRequestPut(context({ order: [3] }) as never)).status).toBe(400);
    expect((await onRequestPut(context({ order: "bad" }) as never)).status).toBe(400);
    expect((await onRequestPut(context({ order: [1], extra: 1 }) as never)).status).toBe(400);
  });

  it("returns 403 when CSRF is invalid", async () => {
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    expect((await onRequestPut(context({ order: [1] }) as never)).status).toBe(403);
  });
});
