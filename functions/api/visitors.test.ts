/** /api/visitors 聚合与状态码过滤测试（mock D1 与登录校验）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./visitors";
import { queryAll } from "../_lib/d1";
import { requireAuth } from "../_lib/session";
import type { Env } from "../_lib/env";

vi.mock("../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../_lib/session", () => ({ requireAuth: vi.fn() }));

const env = {} as Env;

function context(request: Request) {
  return {
    request,
    env,
    params: {},
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({} as never);
});

describe("visitors API", () => {
  it("returns aggregates and markers for all statuses", async () => {
    vi.mocked(queryAll)
      .mockResolvedValueOnce([{ ips: 2, requests: 4, countries: 1 }])
      .mockResolvedValueOnce([{ status: 200, n: 3 }, { status: 404, n: 1 }])
      .mockResolvedValueOnce([
        { ip: "1.1.1.1", country: "US", count: 3, last_ts: "2026-01-01 00:00:00" },
      ])
      .mockResolvedValueOnce([{ ip: "1.1.1.1", status: 200, n: 3 }]);

    const resp = await onRequestGet(context(new Request("https://visitor.limooo.cn/api/visitors")) as never);
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.stats.total_requests).toBe(4);
    expect(data.status_counts["200"]).toBe(3);
    expect(data.markers[0].ip).toBe("1.1.1.1");
  });

  it("passes the status filter to D1", async () => {
    vi.mocked(queryAll)
      .mockResolvedValueOnce([{ ips: 1, requests: 1, countries: 0 }])
      .mockResolvedValueOnce([{ status: 404, n: 1 }])
      .mockResolvedValueOnce([{ ip: "2.2.2.2", country: "", count: 1, last_ts: "2026-01-01 00:00:00" }])
      .mockResolvedValueOnce([{ ip: "2.2.2.2", status: 404, n: 1 }]);

    await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors?status=404")) as never,
    );
    expect(vi.mocked(queryAll).mock.calls[2][1]).toContain("WHERE v.status = ?");
    expect(vi.mocked(queryAll).mock.calls[2][2]).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const resp = await onRequestGet(context(new Request("https://visitor.limooo.cn/api/visitors")) as never);
    expect(resp.status).toBe(401);
  });
});
