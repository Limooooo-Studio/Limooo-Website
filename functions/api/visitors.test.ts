/** /api/visitors 聚合与状态码兼容测试（mock D1 与登录校验）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./visitors";
import { queryAll } from "../_lib/d1";
import { requireAuth } from "../_lib/session";
import type { Env } from "../_lib/env";

vi.mock("../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(() => new Response("unavailable", { status: 503 })),
  // 与生产同策略：委托给桩化的 requireAuth，未登录 401、非 admin 403。
  requireAdminSession: vi.fn(async (env: unknown, request: Request, forbidden = "只读账户，无写入权限") => {
    const { requireAuth: mocked } = await import("../_lib/session");
    const session = await (mocked as (...a: unknown[]) => Promise<unknown>)(env, request);
    if (!session) {
      return Response.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if ((session as { role?: string }).role !== "admin") {
      return Response.json({ error: forbidden }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    return { session };
  }),
}));

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
          last_ts: 1767225600,
        },
        {
          ip_hash: "abc123",
          country: "US",
          status: 404,
          n: 1,
          last_ts: 1767312000,
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
    expect(vi.mocked(queryAll).mock.calls[0][3]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][1]).toContain("LIMIT 500");
    expect(vi.mocked(queryAll).mock.calls[1][2]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][3]).toBe(expectedCutoff);

    expect(data.stats.total_requests).toBe(4);
    expect(data.stats.total_ips).toBe(2);
    expect(data.status_counts["200"]).toBe(3);
    expect(data.status_counts["404"]).toBe(1);
    expect(data.markers[0].ip_hash).toBe("abc123");
    expect(data.markers[0].ip).toBeNull();
    expect(data.markers[0].count).toBe(4);
    expect(data.markers[0].last_time).toBe("2026-01-02T00:00:00.000Z");
    expect(data.markers[0].statuses).toEqual({ "200": 3, "404": 1 });
    expect(data.range_days).toBe(30);
    expect(data.max_markers).toBe(500);
  });

  // 回归：国家必须取「最近一次访问」的值。曾经写的是 MAX(country)，那是按
  // 字母序选（'CN' > 'CH'），与时间无关，导致 CN/CH 混合的访客恒显示 CN。
  it("selects the country of the most recent visit, not the alphabetical max", async () => {
    vi.mocked(queryAll)
      .mockResolvedValueOnce([
        { ips: 1, requests: 2, countries: 2, status_series: "200:2" },
      ])
      .mockResolvedValueOnce([
        // 同一访客：较早一次在 CN，最近一次在 CH。
        { ip_hash: "cnch0001", country: "CH", status: 200, n: 1, last_ts: 1767312000 },
        { ip_hash: "cnch0001", country: "CN", status: 200, n: 1, last_ts: 1767225600 },
      ]);

    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    const data = await resp.json();

    // 'CN' > 'CH' 字母序更大，旧实现会在这里返回 CN。
    expect(data.markers[0].country).toBe("CH");

    // SQL 侧必须按「最近一次访问」取国家，不得再出现 MAX(country) 这种字母序选法。
    const markerSql = vi.mocked(queryAll).mock.calls[1][1] as string;
    // SQL 的注释里会引用下面这些反面写法，断言前先剥掉注释，
    // 否则测的是说明文字而不是真正的 SQL。
    const sqlCode = markerSql.replace(/--[^\n]*/g, "");
    expect(sqlCode).toContain("JOIN scoped s ON s.ip_hash = t.ip_hash AND s.ts = t.last_ts");
    expect(sqlCode).not.toContain("MAX(v.country)");
    // 禁止更贵的替代写法（都在线上 D1 实测过，读数远高于 13.1 万的基线）：
    // 相关子查询 1370 万行、NOT EXISTS 753 万行、ROW_NUMBER 全分区 17.5 万行。
    expect(sqlCode).not.toMatch(/SELECT\s+s2\.country/);
    expect(sqlCode).not.toContain("NOT EXISTS");
    expect(sqlCode).not.toContain("ROW_NUMBER()");
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
          last_ts: 1767225600,
        },
      ]);

    await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors?status=404")) as never,
    );

    const markerSql = vi.mocked(queryAll).mock.calls[1][1] as string;
    expect(markerSql).toContain("status = ?");
    expect(vi.mocked(queryAll).mock.calls[1][2]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][3]).toBe(404);
    expect(vi.mocked(queryAll).mock.calls[1][4]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][5]).toBe(404);
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
