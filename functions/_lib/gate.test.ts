/** isBlocked 的 CIDR 精确匹配测试（docs/10）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { banAfterGateFailures, isBlocked } from "./gate";
import { execute, executeBatch, queryAll } from "./d1";
import { logEvent } from "./logging";

vi.mock("./d1", () => ({ execute: vi.fn(), executeBatch: vi.fn(), queryAll: vi.fn() }));
vi.mock("./logging", () => ({ ipHash: vi.fn().mockResolvedValue("hashed-ip"), logEvent: vi.fn() }));

const env = { DB: {} } as never;
const request = new Request("https://limooo.cn/");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(executeBatch).mockResolvedValue(true);
});

describe("banAfterGateFailures", () => {
  const thresholdEnv = {
    DB: {
      prepare: () => ({ bind: () => ({}) }),
    },
    OBSERVABILITY_HMAC_KEY: "observability-test-key",
  } as never;

  it("does not ban before the third failed gate request", async () => {
    vi.mocked(queryAll).mockResolvedValue([{ failures: 2 }]);

    expect(await banAfterGateFailures(thresholdEnv, request, "8.8.8.8")).toBe(false);
    expect(vi.mocked(executeBatch)).not.toHaveBeenCalled();
  });

  it("precisely blocks and audits the third failed gate request", async () => {
    vi.mocked(queryAll).mockResolvedValue([{ failures: 3 }]);

    expect(await banAfterGateFailures(thresholdEnv, request, "8.8.8.8")).toBe(true);
    expect(vi.mocked(executeBatch)).toHaveBeenCalledOnce();
    const statements = vi.mocked(executeBatch).mock.calls[0][1];
    expect(statements).toHaveLength(3);
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      thresholdEnv,
      "gate_threshold_block",
      request,
      expect.objectContaining({ outcome: "blocked", status: 403 }),
    );
  });
});

describe("isBlocked", () => {
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
