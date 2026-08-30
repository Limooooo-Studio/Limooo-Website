/** OIDC 纯函数测试：mock globalThis.fetch，不发起真实网络请求。 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  deriveCodeChallenge,
  exchangeCode,
  verifyBackchannelLogout,
} from "./oidc";

const env: Env = {
  AUTHENTIK_URL: "https://admin.limooo.cn",
  AUTHENTIK_CLIENT_ID: "client-id",
  AUTHENTIK_CLIENT_SECRET: "client-secret",
  AUTHENTIK_ADMIN_GROUPS: "authentik Admins",
} as Env;

const KEY_ID = "test-key";

type RsaJwk = {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  alg: string;
};

let signingKey: CryptoKey;
let jwk: RsaJwk;

function b64urlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64url");
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    preferred_username: "alice",
    email: "alice@example.com",
    groups: ["authentik Admins"],
    iss: `${env.AUTHENTIK_URL}/application/o/visitor/`,
    aud: env.AUTHENTIK_CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: "nonce-1",
    ...overrides,
  };
}

async function signToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey = signingKey,
): Promise<string> {
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(claims));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      new TextEncoder().encode(`${h}.${p}`),
    ),
  );
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

function mockFetch(mock: (input: RequestInfo | URL) => Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => mock(input)),
  );
}

function tokenFetch(token: string): (input: RequestInfo | URL) => Promise<Response> {
  return async (input) => {
    const href = String(input);
    if (href.includes("/token/")) {
      return new Response(
        JSON.stringify({ id_token: token, access_token: "access-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (href.includes("/jwks/")) {
      return new Response(
        JSON.stringify({ keys: [jwk] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (href.includes("/userinfo/")) {
      return new Response(
        JSON.stringify({ groups: ["authentik Admins"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${href}`);
  };
}

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
  signingKey = pair.privateKey;
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk = {
    kty: "RSA",
    n: publicKey.n ?? "",
    e: publicKey.e ?? "",
    kid: KEY_ID,
    alg: "RS256",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("oidc", () => {
  it("builds an authorize URL with nonce and PKCE S256", () => {
    const url = buildAuthorizeUrl(env, "state-1", "https://visitor.limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeChallenge: "challenge-1",
    });
    expect(url).toContain("/application/o/authorize/?");
    expect(url).toContain("state=state-1");
    expect(url).toContain("nonce=nonce-1");
    expect(url).toContain("code_challenge=challenge-1");
    expect(url).toContain("code_challenge_method=S256");
  });

  it("omits PKCE when explicitly disabled", () => {
    const url = buildAuthorizeUrl(
      { ...env, AUTHENTIK_PKCE_ENABLED: "false" } as Env,
      "state-1",
      "https://limooo.cn/login/callback",
      { nonce: "nonce-1", codeChallenge: "challenge-1" },
    );
    expect(url).not.toContain("code_challenge=");
  });

  it("derives a stable S256 challenge", async () => {
    const challenge = await deriveCodeChallenge("verifier-123");
    expect(challenge).toBe(await deriveCodeChallenge("verifier-123"));
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("builds logout URL from provider slug", () => {
    const url = buildLogoutUrl(env, "https://limooo.cn/");
    expect(url).toContain("/application/o/visitor/end-session/?");
    expect(url).toContain("post_logout_redirect_uri=");
  });

  it("handles missing id_token", async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));
    const result = await exchangeCode(env, "bad", "https://visitor.limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.session).toBeUndefined();
    expect(result.reason).toContain("http_400");
  });

  it("maps groups to roles and returns a session", async () => {
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ groups: [] }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://visitor.limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.session?.role).toBe("admin");
    expect(result.session?.user.email).toBe("alice");
  });

  it("uses UserInfo groups when the ID Token omits groups", async () => {
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ groups: undefined }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.session?.role).toBe("admin");
  });

  it("rejects alg:none", async () => {
    const token = await signToken({ alg: "none", kid: KEY_ID }, baseClaims());
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.session).toBeUndefined();
    expect(result.reason).toBe("jwt_alg_unsupported:none");
  });

  it("rejects an invalid signature", async () => {
    const token = await signToken({ alg: "RS256", kid: KEY_ID }, baseClaims());
    const [h, p] = token.split(".");
    mockFetch(tokenFetch(`${h}.${p}.${b64urlEncode(new Uint8Array(256))}`));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.session).toBeUndefined();
    expect(result.reason).toBe("jwt_signature_invalid");
  });

  it("rejects an unrelated issuer", async () => {
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ iss: "https://evil.example" }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.reason).toBe("id_token_issuer_mismatch");
  });

  it("rejects the instance root before the provider slug issuer", async () => {
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ iss: env.AUTHENTIK_URL }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.reason).toBe("id_token_issuer_mismatch");
  });

  it("rejects the wrong audience", async () => {
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ aud: "another-client" }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.reason).toBe("id_token_aud_mismatch");
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ exp: now - 1, iat: now - 100 }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.reason).toBe("id_token_expired");
  });

  it("rejects a nonce mismatch", async () => {
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ nonce: "different-nonce" }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.reason).toBe("id_token_nonce_mismatch");
  });

  it("rejects a future nbf", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ nbf: now + 120 }),
    );
    mockFetch(tokenFetch(token));
    const result = await exchangeCode(env, "code", "https://limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });
    expect(result.reason).toBe("id_token_nbf_invalid");
  });

  it("verifies a backchannel logout token", async () => {
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      {
        ...baseClaims(),
        events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      },
    );
    mockFetch(tokenFetch(token));
    const result = await verifyBackchannelLogout(env, token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("user-1");
  });

  it("sends the Pages UA to authentik JWKS, token and userinfo endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const token = await signToken(
      { alg: "RS256", kid: KEY_ID },
      baseClaims({ groups: [] }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        const href = String(input);
        if (href.includes("/token/")) {
          return new Response(
            JSON.stringify({ id_token: token, access_token: "access-token" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (href.includes("/jwks/")) {
          return new Response(
            JSON.stringify({ keys: [jwk] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (href.includes("/userinfo/")) {
          return new Response(
            JSON.stringify({ groups: ["authentik Admins"] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch ${href}`);
      }),
    );

    const result = await exchangeCode(env, "code", "https://visitor.limooo.cn/login/callback", {
      nonce: "nonce-1",
      codeVerifier: "verifier",
    });

    expect(result.session?.role).toBe("admin");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string> | undefined;
      expect(headers?.["User-Agent"]).toBe("Mozilla/5.0 (compatible; limooo-pages/1.0)");
    }
  });
});
