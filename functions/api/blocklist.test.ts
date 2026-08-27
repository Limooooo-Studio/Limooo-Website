/** /api/blocklist 管理 API 测试（docs/10）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestDelete, onRequestGet, onRequestPost } from "./blocklist";
import { execute, executeBatch, queryAll } from "../_lib/d1";
import { logEvent } from "../_lib/logging";
import { requireAuth } from "../_lib/session";

vi.mock("../_lib/d1", () => ({
  queryAll: vi.fn(),
  execute: vi.fn(),
  executeBatch: vi.fn(),
}));
vi.mock("../_lib/logging", () => ({ logEvent: vi.fn() }));
vi.mock("../_lib/session", () => ({ requireAuth: vi.fn() }));

const env = {
  DB: { batch: undefined as (() => unknown) | undefined },
} as never;

function context(request: Request) {
  return {
    request,
    env,
    params: {},
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

function adminSession() {
  return {
    sid: "sid-1",
    sub: "sub-1",
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin" as const,
    authAt: 1,
    exp: 9999999999,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(adminSession());
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(executeBatch).mockResolvedValue(true);
});

describe("blocklist API", () => {
  it("returns paginated rows for admins", async () => {
    vi.mocked(queryAll)
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        {
          cidr: "1.2.3.0/24",
          network: "1.2.3.0",
          prefix: 24,
          reason: "",
          source: "auto_block",
          created_at: "2026-08-27 00:00:00",
          updated_at: "2026-08-27 00:00:00",
          updated_by: "auto_block",
          active: 1,
        },
      ]);
    const resp = await onRequestGet(
      context(new Request("https://limooo.cn/api/blocklist?page=1&page_size=10")) as never,
    );
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.total).toBe(1);
    expect(data.items[0].cidr).toBe("1.2.3.0/24");
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const resp = await onRequestGet(context(new Request("https://limooo.cn/api/blocklist")) as never);
    expect(resp.status).toBe(401);
  });

  it("adds a canonical cidr with audit", async () => {
    const resp = await onRequestPost(
      context(
        new Request("https://limooo.cn/api/blocklist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cidr: "1.2.3.4", reason: "manual block" }),
        }),
      ) as never,
    );
    const data = await resp.json();
    expect(resp.status).toBe(201);
    expect(data.cidr).toBe("1.2.3.4/32");
    expect(vi.mocked(execute)).toHaveBeenCalled();
    expect(vi.mocked(logEvent)).toHaveBeenCalled();
  });

  it("soft-deletes an active row with audit", async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([
      {
        cidr: "1.2.3.0/24",
        network: "1.2.3.0",
        prefix: 24,
        reason: "old",
        source: "auto_block",
        created_at: "2026-08-27 00:00:00",
        updated_at: "2026-08-27 00:00:00",
        updated_by: "auto_block",
        active: 1,
      },
    ]);
    const resp = await onRequestDelete(
      context(new Request("https://limooo.cn/api/blocklist?cidr=1.2.3.0/24")) as never,
    );
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.action).toBe("unblock");
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("UPDATE blocked_ips");
  });
});
