import { describe, expect, it, vi } from "vitest";
import { archivePreviousDay } from "./index";

function env() {
  const put = vi.fn().mockResolvedValue({ key: "ok" });
  const all = vi.fn().mockResolvedValue({ results: [{ id: 1, status: 302 }], success: true });
  const bind = vi.fn().mockReturnValue({ all });
  return {
    env: {
      DB: { prepare: vi.fn().mockReturnValue({ bind }) },
      ARCHIVE: { put },
    },
    put,
    bind,
  } as const;
}

describe("d1 archive", () => {
  it("archives the previous UTC day to one gzip object per table", async () => {
    const f = env();
    const counts = await archivePreviousDay(f.env as never, new Date("2026-09-09T00:00:00Z"));
    expect(counts).toEqual({
      visitor_rollups: 1,
      visitors_v2: 1,
      ray_log_v2: 1,
      events: 1,
    });
    expect(f.put).toHaveBeenCalledTimes(4);
    expect(f.put.mock.calls[0][0]).toBe("visitor_rollups_2026_09_08.jsonl.gz");
    expect(f.put.mock.calls[0][2]).toEqual({
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    });
  });
});
