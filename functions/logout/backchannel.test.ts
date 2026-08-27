/** authentik Backchannel Logout 路由测试。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPost } from "./backchannel";
import { verifyBackchannelLogout } from "../_lib/oidc";
import {
  authUnavailableResponse,
  revokeAuthSessionsBySub,
  runtimeConfigError,
} from "../_lib/session";
import type { Env } from "../_lib/env";

vi.mock("../_lib/oidc", () => ({
  verifyBackchannelLogout: vi.fn(),
}));
vi.mock("../_lib/session", () => ({
  authUnavailableResponse: vi.fn(),
  configErrorResponse: vi.fn(() => new Response("503", { status: 503 })),
  revokeAuthSessionsBySub: vi.fn(),
  runtimeConfigError: vi.fn(() => null),
}));

const env = {} as Env;

function context(body: URLSearchParams) {
  return {
    env,
    request: new Request("https://limooo.cn/logout/backchannel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    params: {},
    next: async () => new Response("next"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runtimeConfigError).mockReturnValue(null);
  vi.mocked(revokeAuthSessionsBySub).mockResolvedValue(true);
  vi.mocked(authUnavailableResponse).mockReturnValue(
    Response.json({ error: "auth_sessions_unavailable" }, { status: 503 }),
  );
});

describe("backchannel logout route", () => {
  it("revokes all sessions for a valid logout_token", async () => {
    vi.mocked(verifyBackchannelLogout).mockResolvedValue({
      ok: true,
      claims: { sub: "user-1" } as never,
    });
    const resp = await onRequestPost(
      context(new URLSearchParams({ logout_token: "jwt" })) as never,
    );
    expect(resp.status).toBe(200);
    expect(revokeAuthSessionsBySub).toHaveBeenCalledWith(env, "user-1");
  });

  it("rejects missing tokens", async () => {
    const resp = await onRequestPost(context(new URLSearchParams()) as never);
    expect(resp.status).toBe(400);
  });

  it("returns 503 when revocation storage is unavailable", async () => {
    vi.mocked(verifyBackchannelLogout).mockResolvedValue({
      ok: true,
      claims: { sub: "user-1" } as never,
    });
    vi.mocked(revokeAuthSessionsBySub).mockResolvedValue(false);
    const resp = await onRequestPost(
      context(new URLSearchParams({ logout_token: "jwt" })) as never,
    );
    expect(resp.status).toBe(503);
  });
});
