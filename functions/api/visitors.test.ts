/** /api/visitors 聚合与状态码兼容测试（mock D1 与登录校验）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
  vi.mocked(requireAuth).mockResolvedValue({ role: "admin" } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("visitors API", () => {
  it("returns aggregates, status counts and markers in two D1 queries", async () => {
    const expectedCutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    vi.mocked(queryAll)
      .mockResolvedValueOnce([
        { ips: 2, requests: 4, countries: 1, status_series: "200:3,404:1" },
      ])
      .mockResolvedValueOnce([
        {
          ip_hash: "abc123",
          country: "US",
          status: 200,
          n: 3,
          last_ts: "2026-01-01 00:00:00",
        },
        {
          ip_hash: "abc123",
          country: "US",
          status: 404,
          n: 1,
          last_ts: "2026-01-02 00:00:00",
        },
      ]);

    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(vi.mocked(queryAll)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(queryAll).mock.calls[0][1]).toContain("GROUP_CONCAT");
    expect(vi.mocked(queryAll).mock.calls[0][2]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][1]).toContain("LIMIT 500");
    expect(vi.mocked(queryAll).mock.calls[1][2]).toBe(expectedCutoff);

    expect(data.stats.total_requests).toBe(4);
    expect(data.stats.total_ips).toBe(2);
    expect(data.status_counts["200"]).toBe(3);
    expect(data.status_counts["404"]).toBe(1);
    expect(data.markers[0].ip_hash).toBe("abc123");
    expect(data.markers[0].ip).toBeNull();
    expect(data.markers[0].count).toBe(4);
    expect(data.markers[0].last_time).toBe("2026-01-02 00:00:00");
    expect(data.markers[0].statuses).toEqual({ "200": 3, "404": 1 });
    expect(data.range_days).toBe(30);
    expect(data.max_markers).toBe(500);
  });

  it("keeps the status filter compatible and applies the same 30-day window", async () => {
    const expectedCutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    vi.mocked(queryAll)
      .mockResolvedValueOnce([
        { ips: 1, requests: 1, countries: 0, status_series: "404:1" },
      ])
      .mockResolvedValueOnce([
        {
          ip_hash: "def456",
          country: "",
          status: 404,
          n: 1,
          last_ts: "2026-01-01 00:00:00",
        },
      ]);

    await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors?status=404")) as never,
    );

    const markerSql = vi.mocked(queryAll).mock.calls[1][1] as string;
    expect(markerSql).toContain("status = ?");
    expect(vi.mocked(queryAll).mock.calls[1][2]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][3]).toBe(404);
  });

  it("returns 400 for an invalid status param without querying D1", async () => {
    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors?status=all")) as never,
    );
    expect(resp.status).toBe(400);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns empty aggregates when there are no recent rows", async () => {
    vi.mocked(queryAll)
      .mockResolvedValueOnce([{ ips: 0, requests: 0, countries: 0, status_series: null }])
      .mockResolvedValueOnce([]);

    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    const data = await resp.json();

    expect(data.stats).toEqual({ total_ips: 0, total_requests: 0, countries: 0 });
    expect(data.status_counts).toEqual({});
    expect(data.markers).toEqual([]);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    expect(resp.status).toBe(401);
  });

  it("returns 403 for non-admin sessions", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ role: "viewer" } as never);
    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    expect(resp.status).toBe(403);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });
});
