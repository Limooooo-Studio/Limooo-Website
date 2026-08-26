/** OIDC 纯函数测试：mock globalThis.fetch，不发起真实网络请求。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { buildAuthorizeUrl, buildLogoutUrl, exchangeCode } from "./oidc";

const env: Env = {
  AUTHENTIK_URL: "https://identity.limooo.cn",
  AUTHENTIK_CLIENT_ID: "client-id",
  AUTHENTIK_CLIENT_SECRET: "client-secret",
  AUTHENTIK_ADMIN_GROUPS: "authentik Admins",
} as Env;

function idToken(claims: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("oidc", () => {
  it("builds authorize URL", () => {
    const url = buildAuthorizeUrl(env, "state-1", "https://visitor.limooo.cn/login/callback");
    expect(url).toContain("/application/o/authorize/?");
    expect(url).toContain("state=state-1");
    expect(url).toContain("client_id=client-id");
  });

  it("builds logout URL from provider slug", () => {
    const url = buildLogoutUrl(env, "https://limooo.cn/");
    expect(url).toContain("/application/o/limooo/end-session/?");
    expect(url).toContain("post_logout_redirect_uri=");
  });

  it("handles missing id_token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })));
    const result = await exchangeCode(env, "bad", "https://visitor.limooo.cn/login/callback");
    expect(result.session).toBeUndefined();
    expect(result.reason).toContain("http_400");
  });

  it("maps groups to roles and returns session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id_token: idToken({
        sub: "user-1",
        preferred_username: "alice",
        email: "alice@example.com",
        groups: ["authentik Admins"],
      }),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const result = await exchangeCode(env, "code", "https://visitor.limooo.cn/login/callback");
    expect(result.session?.role).toBe("admin");
    expect(result.session?.user.email).toBe("alice");
  });

  it("handles fetch exceptions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback");
    expect(result.reason).toBe("fetch_exception");
  });
});
