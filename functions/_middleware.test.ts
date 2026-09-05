/** 强制主题挑战门禁编排测试：必须无视白名单 IP / cf_clearance，并固定跳 auth。 */

import { describe, expect, it, vi } from "vitest";
import { handleOnRequest } from "./_middleware";
import type { Env } from "./_lib/env";
import type { RequestContext } from "./_lib/routing";

vi.mock("./_lib/tracking", () => ({
  isTrustedCrawler: () => false,
  recordRay: () => Promise.resolve(),
  recordVisit: () => Promise.resolve(),
  shouldTrackRay: () => false,
  shouldTrackVisit: () => false,
}));

const keys = {
  TURNSTILE_SECRET: "turnstile-secret",
  GATE_HMAC_KEY: "a".repeat(64),
  SESSION_HMAC_KEY: "b".repeat(64),
};

function context(request: Request, env: Partial<Env> = {}): RequestContext {
  return {
    request,
    env: { ...keys, ...env } as Env,
    next: async () => new Response("next", { status: 200 }),
    waitUntil: async () => undefined,
  };
}

describe("force theme challenge", () => {
  it("redirects whitelisted/cf-cleared main-site requests to the same-host gate", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/services?challenge=1", {
          headers: {
            "CF-Connecting-IP": "97.64.18.11",
            Cookie: "cf_clearance=test",
          },
        }),
      ),
    );

    expect(resp.status).toBe(302);
    const location = resp.headers.get("Location") ?? "";
    expect(location).toContain("https://limooo.cn/__gate");
    expect(location).toContain("challenge=1");
    expect(decodeURIComponent(new URL(location).searchParams.get("next") ?? "")).not.toContain("challenge=1");
  });

  it("renders the gate on the same host when a challenge is forced", async () => {
    const resp = await handleOnRequest(
      context(
        new Request(
          "https://limooo.cn/__gate?challenge=1&host=limooo.cn&next=%2Fservices",
          { headers: { Cookie: "cf_clearance=test" } },
        ),
        {
          ASSETS: {
            fetch: async () =>
              new Response(
                "<html><body>{{host}} {{next}} {{lang}} {{error}}</body></html>",
                { headers: { "Content-Type": "text/html" } },
              ),
          },
        },
      ),
    );

    expect(resp.status).toBe(403);
    expect(resp.headers.get("Location")).toBeNull();
  });

  it("serves redirect static assets directly instead of rendering the redirect page", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://redirect.limooo.cn/static/css/redirect.css"),
      ),
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("next");
  });

  it("serves the health probe without human verification", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/_health", {
          headers: { "CF-Connecting-IP": "1.2.3.4" },
        }),
      ),
    );

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok\n");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves public pages with edge-cache headers", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            "CF-Connecting-IP": "97.64.18.11",
            Cookie: "user_lang_preference=zh-cn",
          },
        }),
        {
          ASSETS: {
            fetch: async () =>
              new Response("<html>home</html>", {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
          },
        },
      ),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Cache-Control")).toContain("s-maxage=300");
    expect(resp.headers.get("Vary")).toContain("Accept-Language");
  });
});
