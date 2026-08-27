/** Ray API 权限与最小字段测试。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./[id]";
import { queryAll } from "../../_lib/d1";
import { requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

vi.mock("../../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../../_lib/session", () => ({ requireAuth: vi.fn() }));

const env = {} as Env;

function context() {
  return {
    request: new Request("https://visitor.limooo.cn/api/ray/0123456789abcdef"),
    env,
    params: { id: "0123456789abcdef" },
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
  vi.mocked(queryAll).mockResolvedValue([{
    ray: "0123456789abcdef-ABC",
    ts: 1,
    host: "limooo.cn",
    path: "/",
    method: "GET",
    status: 200,
    ip_hash: "abc123",
    ua_family: "chrome",
    ip: "1.2.3.4",
    ua: "full-user-agent",
    country: "US",
  }] as never);
});

describe("ray API", () => {
  it("requires an admin session", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    expect((await onRequestGet(context() as never)).status).toBe(401);
    vi.mocked(requireAuth).mockResolvedValue({
      sid: "sid-1",
      sub: "user-1",
      user: { email: "viewer@example.com", name: "Viewer" },
      role: "viewer",
      authAt: 1,
    } as never);
    expect((await onRequestGet(context() as never)).status).toBe(403);
  });

  it("returns only minimal fields and no-store headers", async () => {
    const resp = await onRequestGet(context() as never);
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.rows[0]).toMatchObject({
      ray: "0123456789abcdef-ABC",
      ip_hash: "abc123",
      ua_family: "chrome",
      method: "GET",
      status: 200,
    });
    expect(data.rows[0]).not.toHaveProperty("ip");
    expect(data.rows[0]).not.toHaveProperty("ua");
    expect(data.rows[0]).not.toHaveProperty("country");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });
});
