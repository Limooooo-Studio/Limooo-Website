/** /api/visitors/<hash>/ip：admin-only 单行解密。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./ip";
import { queryAll } from "../../../_lib/d1";
import { requireAuth } from "../../../_lib/session";
import { fernetEncrypt } from "../../../_lib/fernet";
import type { Env } from "../../../_lib/env";

vi.mock("../../../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(() => new Response("unavailable", { status: 503 })),
}));

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const HASH = "0123456789abcdef";

function context(hash: string, env: Env) {
  return {
    request: new Request(`https://visitor.limooo.cn/api/visitors/${hash}/ip`),
    env,
    params: { hash },
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ role: "admin" } as never);
  vi.mocked(queryAll).mockResolvedValue([]);
});

describe("visitor ip API", () => {
  it("decrypts the most recent encrypted IP of that hash", async () => {
    const token = await fernetEncrypt("8.8.8.8", TEST_KEY);
    vi.mocked(queryAll).mockResolvedValueOnce([{ ip_enc: token }]);

    const resp = await onRequestGet(
      context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(data.ip).toBe("8.8.8.8");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    const sql = vi.mocked(queryAll).mock.calls[0][1] as string;
    expect(sql).toContain("FROM visitor_rollups");
    expect(sql).toContain("ORDER BY last_ts DESC");
    expect(vi.mocked(queryAll).mock.calls[0][2]).toBe(HASH);
  });

  it("returns 401 when unauthenticated and 403 for non-admins", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    let resp = await onRequestGet(context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never);
    expect(resp.status).toBe(401);

    vi.mocked(requireAuth).mockResolvedValue({ role: "viewer" } as never);
    resp = await onRequestGet(context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never);
    expect(resp.status).toBe(403);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed hash without touching D1", async () => {
    const resp = await onRequestGet(
      context("NOT-A-HASH", { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    expect(resp.status).toBe(400);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns 503 when the decryption key is missing", async () => {
    const resp = await onRequestGet(context(HASH, {} as Env) as never);
    expect(resp.status).toBe(503);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns 404 for legacy rows or rows without ciphertext", async () => {
    const resp = await onRequestGet(
      context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toBe("ip_unavailable");
  });

  it("returns 500 without leaking anything when the ciphertext is corrupt", async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([{ ip_enc: "corrupted-token" }]);
    const resp = await onRequestGet(
      context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    expect(resp.status).toBe(500);
    expect((await resp.json()).error).toBe("ip_unavailable");
  });
});
