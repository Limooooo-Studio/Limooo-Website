/** sync-worker 差异计算与 dry-run 基础测试（docs/10）。 */

import { describe, expect, it } from "vitest";
import { authorized, diffSync, normalizeListItem, sync } from "./index";

const envWith = (token: string) => ({ SYNC_TOKEN: token }) as never;
const reqWith = (auth?: string) =>
  new Request("https://limooo-blocklist-sync.limooo.workers.dev/", {
    headers: auth ? { Authorization: auth } : {},
  });

describe("sync-worker", () => {
  it("computes add/remove diff", () => {
    const result = diffSync(
      new Set(["1.2.3.0/24", "2001:db8::/64"]),
      new Map([
        ["1.2.3.0/24", "item-1"],
        ["4.5.6.0/24", "item-2"],
      ]),
    );
    expect(result.toAdd).toContain("2001:db8::/64");
    expect(result.toRemove).toContain("4.5.6.0/24");
    expect(result.toAdd).not.toContain("1.2.3.0/24");
  });

  it("skips without credentials", async () => {
    const env = {
      DB: { prepare: () => ({ all: async () => ({ results: [], success: true }) }) },
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
    } as never;
    const result = await sync(env);
    expect(result).toEqual({ toAdd: [], toRemove: [] });
  });
});

/**
 * 回归（2026-09-21 实测）：Cloudflare IP List 会把 /32 归一化成裸 IP
 * （写入 1.2.3.4/32，读回 1.2.3.4）。若直接用原始字符串比较，同一条记录
 * 会同时出现在 toAdd 与 toRemove，导致每次同步反复删除重加。
 */
describe("normalizeListItem", () => {
  it("把 IPv4 /32 与 IPv6 /128 归一化成裸 IP", () => {
    expect(normalizeListItem("1.2.3.4/32")).toBe("1.2.3.4");
    expect(normalizeListItem("2001:db8::1/128")).toBe("2001:db8::1");
  });

  it("保留真正的网段前缀，裸 IP 原样返回", () => {
    expect(normalizeListItem("1.2.3.0/24")).toBe("1.2.3.0/24");
    expect(normalizeListItem("2001:db8::/64")).toBe("2001:db8::/64");
    expect(normalizeListItem("1.2.3.4")).toBe("1.2.3.4");
  });
});

describe("diffSync 与 /32 归一化", () => {
  it("不会把已存在的 /32 重复判为待添加", () => {
    // D1 是 /32，Cloudflare 存裸 IP —— 修复前这里既 toAdd 又 toRemove。
    const result = diffSync(
      new Set(["1.2.3.4/32", "5.6.7.0/24"]),
      new Map([
        ["1.2.3.4", "id1"],
        ["9.9.9.9", "id2"],
      ]),
    );
    expect(result.toAdd).toEqual(["5.6.7.0/24"]);
    expect(result.toRemove).toEqual(["9.9.9.9"]);
  });

  it("两侧一致时无任何操作（幂等）", () => {
    const result = diffSync(new Set(["1.2.3.4/32"]), new Map([["1.2.3.4", "id1"]]));
    expect(result.toAdd).toEqual([]);
    expect(result.toRemove).toEqual([]);
  });

  it("同一条记录不会同时出现在 toAdd 与 toRemove", () => {
    const result = diffSync(new Set(["1.2.3.4/32"]), new Map([["1.2.3.4", "id1"]]));
    const overlap = result.toAdd.filter((ip) => result.toRemove.includes(ip));
    expect(overlap).toEqual([]);
  });
});

/**
 * 手动触发端点的鉴权（workers.dev 无法用 zone 级 mTLS，改用共享密钥）。
 * 关键行为：未配置 SYNC_TOKEN 时必须 fail-closed。
 */
describe("authorized", () => {
  it("token 正确时放行", () => {
    expect(authorized(reqWith("Bearer s3cret-token"), envWith("s3cret-token"))).toBe(true);
  });

  it("缺少 Authorization 头时拒绝", () => {
    expect(authorized(reqWith(), envWith("s3cret-token"))).toBe(false);
  });

  it("token 错误或长度不符时拒绝", () => {
    expect(authorized(reqWith("Bearer wrong"), envWith("s3cret-token"))).toBe(false);
    expect(authorized(reqWith("Bearer s3cret-toke"), envWith("s3cret-token"))).toBe(false);
    expect(authorized(reqWith("Bearer s3cret-tokenX"), envWith("s3cret-token"))).toBe(false);
  });

  it("缺少 Bearer 前缀时拒绝", () => {
    expect(authorized(reqWith("s3cret-token"), envWith("s3cret-token"))).toBe(false);
  });

  it("未配置 SYNC_TOKEN 时 fail-closed（不能因为忘设 secret 就开放）", () => {
    expect(authorized(reqWith("Bearer anything"), envWith(""))).toBe(false);
    expect(authorized(reqWith("Bearer "), envWith(""))).toBe(false);
    expect(authorized(reqWith("Bearer undefined"), { SYNC_TOKEN: undefined } as never)).toBe(false);
  });
});
