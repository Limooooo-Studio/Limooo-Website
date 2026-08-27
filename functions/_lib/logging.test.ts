/** 日志隐私纯函数测试：独立观测密钥 + 敏感文本脱敏，不访问 D1/网络。 */

import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { ipHash, sanitizeLogMessage } from "./logging";

describe("logging privacy", () => {
  it("uses only OBSERVABILITY_HMAC_KEY and fails closed when it is missing", async () => {
    const obs = await ipHash("8.8.8.8", { OBSERVABILITY_HMAC_KEY: "obs" } as Env);
    const gate = await ipHash("8.8.8.8", {
      GATE_HMAC_KEY: "gate",
      OBSERVABILITY_HMAC_KEY: "obs",
    } as Env);
    expect(obs).toBe(gate);
    expect(obs).toMatch(/^[0-9a-f]{16}$/);
    expect(await ipHash("8.8.8.8", { GATE_HMAC_KEY: "gate" } as Env)).toBe("");
  });

  it("redacts passwords, bearer tokens, cookies and query strings", () => {
    const clean = sanitizeLogMessage(
      'login password=seekrit&token=abc123 | Bearer abc.def | Cookie: __gate=xyz | /api/a?q=secret',
    );
    expect(clean).not.toContain("seekrit");
    expect(clean).not.toContain("abc.def");
    expect(clean).not.toContain("__gate=xyz");
    expect(clean).not.toContain("q=secret");
    expect(clean).toContain("[redacted]");
  });
});
