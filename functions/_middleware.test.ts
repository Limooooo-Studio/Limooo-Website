/** 强制主题挑战门禁编排测试：必须无视白名单 IP / cf_clearance，并保持原 URL。 */

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
  it("renders the gate at an unverified visitor's original URL", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/"),
        {
          ASSETS: {
            fetch: async () => new Response("{{host}} {{next}}", {
              headers: { "Content-Type": "text/html" },
            }),
          },
        },
      ),
    );

    expect(resp.status).toBe(403);
    expect(resp.headers.get("Location")).toBeNull();
    await expect(resp.text()).resolves.toContain("limooo.cn /");
  });

  it("renders the gate at the original URL for forced challenges", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/services?challenge=1", {
          headers: {
            "CF-Connecting-IP": "97.64.18.11",
            Cookie: "cf_clearance=test",
          },
        }),
        {
          ASSETS: {
            fetch: async () => new Response("{{host}} {{next}}", {
              headers: { "Content-Type": "text/html" },
            }),
          },
        },
      ),
    );

    expect(resp.status).toBe(403);
    expect(resp.headers.get("Location")).toBeNull();
    await expect(resp.text()).resolves.toContain("limooo.cn /services");
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

  it("ignores client-supplied X-Limooo-Client-IP when deciding trust", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            "CF-Connecting-IP": "203.0.113.9",
            "X-Limooo-Client-IP": "97.64.18.11",
            "X-Limooo-Client-Country": "CN",
          },
        }),
        {
          ASSETS: {
            fetch: async () => new Response("{{host}} {{next}}", {
              headers: { "Content-Type": "text/html" },
            }),
          },
        },
      ),
    );

    expect(resp.status).toBe(403);
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

  it("renders the gate page in place on the gate host for verified visitors", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://auth.limooo.cn/", {
          headers: { "CF-Connecting-IP": "97.64.18.11" },
        }),
        {
          ASSETS: {
            fetch: async () =>
              new Response("{{host}} {{next}}", {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
          },
        },
      ),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Location")).toBeNull();
    await expect(resp.text()).resolves.toContain("auth.limooo.cn /");
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

describe("public /files", () => {
  const assetsEnv = (env: Partial<Env> = {}) => ({
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/static/files/after_sign_in.png")) {
          return new Response("png-bytes", {
            headers: { "Content-Type": "image/png", ETag: '"abc"' },
          });
        }
        return new Response("missing", { status: 404 });
      },
    },
    ...env,
  });

  it("serves /files/<name> without the gate, even for an unverified visitor", async () => {
    const resp = await handleOnRequest(
      context(new Request("https://limooo.cn/files/after_sign_in.png"), assetsEnv()),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
    expect(resp.headers.get("Cache-Control")).toContain("max-age=86400");
    await expect(resp.text()).resolves.toBe("png-bytes");
  });

  it("also maps the clean URL on the images subdomain", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://images.limooo.cn/files/after_sign_in.png"),
        assetsEnv(),
      ),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
  });

  it("404s unknown names and path traversal without touching the gate", async () => {
    const unknown = await handleOnRequest(
      context(new Request("https://limooo.cn/files/nope.png"), assetsEnv()),
    );
    expect(unknown.status).toBe(404);

    const traversal = await handleOnRequest(
      context(new Request("https://limooo.cn/files/..%2Fsecrets"), assetsEnv()),
    );
    expect(traversal.status).toBe(404);
  });
});
