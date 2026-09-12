/** isBlocked 的 CIDR 精确匹配测试（docs/10）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGateDiag, handleVerify, isBlocked } from "./gate";
import type { RequestContext } from "./routing";
import { queryAll } from "./d1";
import { logEvent } from "./logging";

vi.mock("./d1", () => ({ queryAll: vi.fn() }));
vi.mock("./logging", () => ({ logEvent: vi.fn() }));

const env = { DB: {} } as never;
const request = new Request("https://limooo.cn/");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isBlocked", () => {
  it("shows the visitor IP/country forwarded by the origin proxy", async () => {
    const req = new Request("https://auth.limooo.cn/__gate/diag", {
      headers: {
        "CF-Connecting-IP": "43.108.57.161",
        "X-Limooo-Client-IP": "203.0.113.9",
        "X-Limooo-Client-Country": "jp",
      },
    });
    const diag = handleGateDiag({ request: req } as RequestContext);
    expect(await diag.json()).toMatchObject({ ip: "203.0.113.9", country: "JP" });
  });

  it("falls back to the connecting IP when no forwarded header is present", async () => {
    const req = new Request("https://auth.limooo.cn/__gate/diag", {
      headers: { "CF-Connecting-IP": "43.108.57.161", "X-Limooo-Client-IP": "not-an-ip" },
    });
    const diag = handleGateDiag({ request: req } as RequestContext);
    expect(await diag.json()).toMatchObject({ ip: "43.108.57.161", country: "—" });
  });

  it("matches IPv4 /24 with normalized network/prefix", async () => {
    vi.mocked(queryAll).mockResolvedValue([
      { cidr: "1.2.3.0/24", network: "1.2.3.0", prefix: 24 },
    ]);
    expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
    expect(vi.mocked(logEvent)).toHaveBeenCalled();
    const sql = vi.mocked(queryAll).mock.calls[0][1];
    expect(sql).toContain("network = ? AND prefix = ?");
  });

  it("matches IPv6 /64 and exact /32 semantics", async () => {
    vi.mocked(queryAll).mockResolvedValue([
      { cidr: "2001:db8::/64", network: "2001:db8::", prefix: 64 },
    ]);
    expect(await isBlocked(env, request, "2001:db8::1")).toBe(true);
  });

  it("returns false when no row matches and logs nothing", async () => {
    vi.mocked(queryAll).mockResolvedValue([]);
    expect(await isBlocked(env, request, "8.8.8.8")).toBe(false);
    expect(vi.mocked(logEvent)).not.toHaveBeenCalled();
  });
});

describe("handleVerify", () => {
  function verifyContext(request: Request) {
    return {
      request,
      env: {
        TURNSTILE_SECRET: "turnstile-secret",
        GATE_HMAC_KEY: "a".repeat(64),
      },
      next: async () => new Response("next"),
    } as never;
  }

  function verifyRequest(accept: string, token = "token"): Request {
    const form = new FormData();
    form.set("cf-turnstile-response", token);
    form.set("host", "limooo.cn");
    form.set("next", "/services");
    return new Request("https://limooo.cn/__gate/verify", {
      method: "POST",
      headers: { Accept: accept },
      body: form,
    });
  }

  it("issues the gate cookie to fetch clients without a redirect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true })));

    const resp = await handleVerify(verifyContext(verifyRequest("application/json")));

    expect(resp.status).toBe(204);
    expect(resp.headers.get("Location")).toBeNull();
    expect(resp.headers.get("Set-Cookie")).toContain("__gate=");
    vi.unstubAllGlobals();
  });

  it("keeps verification errors on the current page for fetch clients", async () => {
    const resp = await handleVerify(verifyContext(verifyRequest("application/json", "")));

    expect(resp.status).toBe(403);
    await expect(resp.json()).resolves.toEqual({ ok: false, error: "failed" });
  });

  it("sends non-JavaScript form posts directly back to the requested host", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true })));

    const resp = await handleVerify(verifyContext(verifyRequest("text/html")));

    expect(resp.status).toBe(303);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/services");
    vi.unstubAllGlobals();
  });
});
