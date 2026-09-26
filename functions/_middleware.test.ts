/** 强制主题挑战门禁编排测试：必须无视白名单 IP / cf_clearance，并保持原 URL。 */

import { describe, expect, it, vi } from "vitest";
import { handleOnRequest } from "./_middleware";
import { mintGateCookie } from "./_lib/gate";
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

  it("308s the legacy /__gate entry and keeps the forced challenge on /gate", async () => {
    const assets = {
      ASSETS: {
        fetch: async () =>
          new Response(
            "<html><body>{{host}} {{next}} {{lang}} {{error}}</body></html>",
            { headers: { "Content-Type": "text/html" } },
          ),
      },
    };

    const legacy = await handleOnRequest(
      context(
        new Request(
          "https://limooo.cn/__gate?challenge=1&host=limooo.cn&next=%2Fservices",
          { headers: { Cookie: "cf_clearance=test" } },
        ),
        assets,
      ),
    );

    expect(legacy.status).toBe(308);
    expect(legacy.headers.get("Location")).toBe(
      "https://limooo.cn/gate?challenge=1&host=limooo.cn&next=%2Fservices",
    );

    // 规范化入口下强制挑战仍不放行；cf_clearance 依旧不是依据。
    const forced = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?challenge=1&host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: "cf_clearance=test" },
        }),
        assets,
      ),
    );

    expect(forced.status).toBe(403);
    expect(forced.headers.get("Location")).toBeNull();
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
    // 边缘缓存必须按 Cookie 分桶，否则预渲染页会按旧语言命中缓存。
    expect(resp.headers.get("Vary")).toContain("Cookie");
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

describe("canonical /gate entry", () => {
  const assetsEnv = {
    ASSETS: {
      fetch: async () =>
        new Response("<html><body>{{host}} {{next}} {{error}}</body></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
  };

  it("serves the gate page for an unverified visitor", async () => {
    const resp = await handleOnRequest(
      context(new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices"), assetsEnv),
    );
    expect(resp.status).toBe(403);
    await expect(resp.text()).resolves.toContain("limooo.cn /services");
  });

  it("sends a visitor holding a valid cookie straight back without re-challenging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: cookie, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );

    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/services");
    vi.useRealTimers();
  });

  it("does not re-issue the cookie on every request while it is still fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];
    vi.setSystemTime((1_700_000_000 + 60) * 1000);

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2F", {
          headers: { Cookie: cookie, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );

    expect(resp.status).toBe(302);
    // 语言 cookie 可能顺带写入，但 __gate 不应被重复签发。
    expect(resp.headers.get("Set-Cookie") ?? "").not.toContain("__gate=");
    vi.useRealTimers();
  });

  it("renews the cookie on a normal page hit once it is 3/4 through its TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];
    // 走完 3/4 TTL 后再访问页面：应在页面响应里顺带续签，而不是弹回门禁页。
    vi.setSystemTime((1_700_000_000 + 2700 + 1) * 1000);

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            Cookie: cookie,
            "CF-Connecting-IP": "203.0.113.7",
            "Host": "limooo.cn",
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
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("__gate=");
    vi.useRealTimers();
  });

  it("does not renew on every page hit, so the hour is not a sliding window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];
    vi.setSystemTime((1_700_000_000 + 120) * 1000);

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            Cookie: cookie,
            "CF-Connecting-IP": "203.0.113.7",
            "Host": "limooo.cn",
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
    expect(resp.headers.get("Set-Cookie") ?? "").not.toContain("__gate=");
    vi.useRealTimers();
  });

  it("accepts the request when a stale __gate precedes a valid one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const valid = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];

    // 旧作用域里那枚已失效的 __gate 排在前面；只看第一枚就会被它挡掉。
    const stale = `__gate=1700000000.1700003600.${"a".repeat(64)}`;
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: `${stale}; ${valid}`, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );
    vi.useRealTimers();

    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/services");
  });

  it("never lets the challenge page be cached at the content URL", async () => {
    const resp = await handleOnRequest(
      context(new Request("https://limooo.cn/services"), assetsEnv),
    );
    expect(resp.status).toBe(403);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });

  it("308s the legacy /__gate entry to /gate, preserving the query", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/__gate?host=limooo.cn&next=%2Fservices"),
        assetsEnv,
      ),
    );

    expect(resp.status).toBe(308);
    expect(resp.headers.get("Location")).toBe(
      "https://limooo.cn/gate?host=limooo.cn&next=%2Fservices",
    );
  });

  it("answers the canonical config/diag/verify endpoints", async () => {
    const config = await handleOnRequest(
      context(new Request("https://limooo.cn/gate/config")),
    );
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toHaveProperty("root_domain", "limooo.cn");

    const diag = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate/diag", {
          headers: { "CF-Connecting-IP": "203.0.113.7" },
        }),
      ),
    );
    expect(diag.status).toBe(200);
  });
});
