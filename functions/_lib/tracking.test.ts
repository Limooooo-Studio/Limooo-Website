/** 埋点最小字段与降噪测试：mock D1，不访问真实数据库/网络。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "./d1";
import type { Env } from "./env";
import {
  pageSlug,
  recordRay,
  recordVisit,
  shouldTrackRay,
  shouldTrackVisit,
  uaFamily,
} from "./tracking";

vi.mock("./d1", () => ({ execute: vi.fn() }));

const env = {
  DB: {},
  OBSERVABILITY_HMAC_KEY: "obs-key-for-tests",
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execute).mockResolvedValue(true);
});

function request(url: string, headers: HeadersInit = {}) {
  return new Request(url, { headers });
}

describe("tracking", () => {
  it("normalizes paths and user agents", () => {
    expect(pageSlug("/portfolio?id=1")).toBe("portfolio");
    expect(pageSlug("/")).toBe("home");
    expect(uaFamily("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("googlebot");
    expect(uaFamily("Mozilla/5.0 (Macintosh; Safari)")).toBe("safari");
  });

  it("skips static, API, gate, image and redirect requests", () => {
    const page = request("https://limooo.cn/", { "CF-Connecting-IP": "1.1.1.1" });
    expect(shouldTrackVisit(page, new URL("https://limooo.cn/"))).toBe(true);
    expect(shouldTrackVisit(page, new URL("https://limooo.cn/static/a.css"))).toBe(false);
    expect(shouldTrackVisit(page, new URL("https://limooo.cn/api/x"))).toBe(false);
    expect(shouldTrackVisit(page, new URL("https://images.limooo.cn/x.webp"))).toBe(false);
    expect(shouldTrackRay(page, new URL("https://limooo.cn/static/a.css"))).toBe(false);
    expect(shouldTrackRay(page, new URL("https://limooo.cn/api/x"))).toBe(false);
    expect(shouldTrackRay(page, new URL("https://limooo.cn/"))).toBe(true);
  });

  it("records visitors without full IP/UA/query", async () => {
    await recordVisit(
      env,
      request("https://limooo.cn/portfolio?secret=1", {
        "CF-Connecting-IP": "8.8.8.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      }),
      200,
    );
    const calls = vi.mocked(execute).mock.calls;
    const insert = calls.find((call) => String(call[1]).includes("INSERT INTO visitors_v2"));
    expect(insert).toBeDefined();
    const values = insert!.slice(2).map(String);
    expect(values).toContain("portfolio");
    expect(values.some((value) => value.includes("8.8.8.8") || value.includes("secret=1"))).toBe(false);
    expect(values.some((value) => value.includes("Macintosh"))).toBe(false);
  });

  it("records ray requests without full IP/UA/query", async () => {
    await recordRay(
      env,
      request("https://limooo.cn/login/callback?code=topsecret", {
        "CF-Ray": "abc123",
        "CF-Connecting-IP": "8.8.8.8",
        "User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.0)",
      }),
      200,
      12,
    );
    const calls = vi.mocked(execute).mock.calls;
    const insert = calls.find((call) => String(call[1]).includes("INSERT OR IGNORE INTO ray_log_v2"));
    expect(insert).toBeDefined();
    const values = insert!.slice(2).map(String);
    expect(values).toContain("/login/callback");
    expect(values.some((value) => value.includes("8.8.8.8") || value.includes("topsecret"))).toBe(false);
    expect(values.some((value) => value.includes("GPTBot"))).toBe(false);
  });
});
