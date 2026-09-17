/**
 * Cloudflare Access JWT 验签单测（docs/17 §11.6 的 7/7 规格）。
 *
 * 用本地生成的 RS256 密钥签发真实 JWT，覆盖：合法通过；iss 不符 / aud 未登记 /
 * 过期 / alg:none / 篡改 payload / 空令牌 全部拒绝。
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessAssertion,
  accessConfigError,
  accessJwksUrl,
  accessLogoutUrl,
  accessTeamDomain,
  roleForAud,
  verifyAccessJwt,
} from "./access";
import type { Env } from "./env";

const TEAM = "https://limooo.cloudflareaccess.com";
const KID = "access-kid";
const ADMIN_AUD = "0e7b7592c7b571b80a27228a4317d7e599d1c6470e7ed303047659b46c68e0dc";
const VIEWER_AUD = "viewer-aud-0000";

const baseEnv: Env = {
  TURNSTILE_SITEKEY: "site",
  TURNSTILE_SECRET: "secret",
  GATE_HMAC_KEY: "gate",
  SESSION_HMAC_KEY: "session",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_ADMIN_AUDS: ADMIN_AUD,
  ACCESS_VIEWER_AUDS: VIEWER_AUD,
};

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signToken(claims: Record<string, unknown>, alg = "RS256"): Promise<string> {
  const header = b64url(JSON.stringify({ alg, kid: KID, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  if (alg !== "RS256") return `${signingInput}.${b64url("bogus-signature")}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${b64url(signature)}`;
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-sub-1",
    email: "lime@limooo.cn",
    iss: TEAM,
    aud: [ADMIN_AUD],
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    ...overrides,
  };
}

// 密钥只生成一次：access.ts 的 JWKS 有 1 小时模块级缓存，
// 每个用例换密钥会互相污染。
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, use: "sig" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("access helpers", () => {
  it("team domain 补全协议并去尾斜杠", () => {
    expect(accessTeamDomain({ ...baseEnv, ACCESS_TEAM_DOMAIN: "limooo.cloudflareaccess.com/" })).toBe(
      TEAM,
    );
    expect(accessTeamDomain({ ...baseEnv, ACCESS_TEAM_DOMAIN: "" })).toBe("");
  });

  it("jwks / logout 端点按 team domain 拼装", () => {
    expect(accessJwksUrl(baseEnv)).toBe(`${TEAM}/cdn-cgi/access/certs`);
    expect(accessLogoutUrl(baseEnv, "https://limooo.cn/")).toBe(
      `${TEAM}/cdn-cgi/access/logout?redirect_url=${encodeURIComponent("https://limooo.cn/")}`,
    );
  });

  it("缺 team domain / AUD 时 fail closed 且只报字段名", () => {
    expect(accessConfigError({ ...baseEnv, ACCESS_TEAM_DOMAIN: "" })).toBe(
      "missing_ACCESS_TEAM_DOMAIN",
    );
    expect(accessConfigError({ ...baseEnv, ACCESS_ADMIN_AUDS: "", ACCESS_VIEWER_AUDS: "" })).toBe(
      "missing_ACCESS_AUDS",
    );
    expect(accessConfigError(baseEnv)).toBeNull();
  });

  it("读取 Access 注入的身份头", () => {
    const req = new Request("https://visitor.limooo.cn/", {
      headers: { "Cf-Access-Jwt-Assertion": "tok" },
    });
    expect(accessAssertion(req)).toBe("tok");
    expect(accessAssertion(new Request("https://visitor.limooo.cn/"))).toBeNull();
  });
});

describe("roleForAud", () => {
  it("admin AUD 优先于 viewer AUD", () => {
    expect(roleForAud(baseEnv, [ADMIN_AUD])).toBe("admin");
    expect(roleForAud(baseEnv, [VIEWER_AUD])).toBe("viewer");
    expect(roleForAud(baseEnv, [VIEWER_AUD, ADMIN_AUD])).toBe("admin");
  });

  it("未登记的 AUD / 空值返回 null", () => {
    expect(roleForAud(baseEnv, ["someone-else"])).toBeNull();
    expect(roleForAud(baseEnv, [])).toBeNull();
    expect(roleForAud(baseEnv, undefined)).toBeNull();
  });
});

describe("verifyAccessJwt", () => {
  it("合法令牌通过并映射为 admin", async () => {
    const identity = await verifyAccessJwt(baseEnv, await signToken(baseClaims()));
    expect(identity).not.toBeNull();
    expect(identity?.role).toBe("admin");
    expect(identity?.email).toBe("lime@limooo.cn");
    expect(identity?.sub).toBe("access:user-sub-1");
  });

  it("viewer AUD 映射为 viewer", async () => {
    const identity = await verifyAccessJwt(baseEnv, await signToken(baseClaims({ aud: [VIEWER_AUD] })));
    expect(identity?.role).toBe("viewer");
  });

  it("iss 不符被拒", async () => {
    const token = await signToken(baseClaims({ iss: "https://evil.cloudflareaccess.com" }));
    expect(await verifyAccessJwt(baseEnv, token)).toBeNull();
  });

  it("aud 未登记被拒", async () => {
    const token = await signToken(baseClaims({ aud: ["unregistered-aud"] }));
    expect(await verifyAccessJwt(baseEnv, token)).toBeNull();
  });

  it("过期令牌被拒", async () => {
    const token = await signToken(baseClaims({ exp: Math.floor(Date.now() / 1000) - 5 }));
    expect(await verifyAccessJwt(baseEnv, token)).toBeNull();
  });

  it("alg:none 被拒", async () => {
    expect(await verifyAccessJwt(baseEnv, await signToken(baseClaims(), "none"))).toBeNull();
  });

  it("篡改 payload 后签名不匹配被拒", async () => {
    const token = await signToken(baseClaims());
    const [header, , signature] = token.split(".");
    const tampered = b64url(JSON.stringify(baseClaims({ email: "attacker@evil.com" })));
    expect(await verifyAccessJwt(baseEnv, `${header}.${tampered}.${signature}`)).toBeNull();
  });

  it("空 / 畸形令牌被拒", async () => {
    expect(await verifyAccessJwt(baseEnv, "")).toBeNull();
    expect(await verifyAccessJwt(baseEnv, null)).toBeNull();
    expect(await verifyAccessJwt(baseEnv, undefined)).toBeNull();
    expect(await verifyAccessJwt(baseEnv, "not-a-jwt")).toBeNull();
    expect(await verifyAccessJwt(baseEnv, "a.b")).toBeNull();
  });

  it("nbf 在未来被拒", async () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(await verifyAccessJwt(baseEnv, await signToken(baseClaims({ nbf: future })))).toBeNull();
  });

  it("缺 sub 被拒", async () => {
    const token = await signToken(baseClaims({ sub: "" }));
    expect(await verifyAccessJwt(baseEnv, token)).toBeNull();
  });

  it("缺 team domain 时 fail closed（不发任何请求）", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const token = await signToken(baseClaims());
    expect(await verifyAccessJwt({ ...baseEnv, ACCESS_TEAM_DOMAIN: "" }, token)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("JWKS 拉取失败且无缓存时拒绝", async () => {
    // 本用例必须跑在冷缓存上，否则会命中前面用例留下的模块级缓存。
    vi.resetModules();
    const cold = await import("./access");
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const token = await signToken(baseClaims());
    expect(await cold.verifyAccessJwt(baseEnv, token)).toBeNull();
  });

  it("JWKS 拉取失败但有缓存时沿用缓存（密钥轮换期不能全员登录失败）", async () => {
    // 先热一次缓存，再让网络挂掉。
    expect(await verifyAccessJwt(baseEnv, await signToken(baseClaims()))).not.toBeNull();
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const token = await signToken(baseClaims());
    expect(await verifyAccessJwt(baseEnv, token)).not.toBeNull();
  });
});
