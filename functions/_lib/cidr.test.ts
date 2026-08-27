/** IPv4/IPv6 规范化与匹配测试（docs/10）。 */

import { describe, expect, it } from "vitest";
import {
  canonicalCidr,
  contains,
  networkAddress,
  normalizeIp,
  parseCidr,
} from "./cidr";

describe("cidr", () => {
  it("normalizes IPv4 and IPv6 addresses", () => {
    expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("2001:::1")).toBeNull();
  });

  it("parses and canonicalizes CIDRs", () => {
    expect(parseCidr("1.2.3")).toEqual({
      network: "1.2.3.0",
      prefix: 24,
      cidr: "1.2.3.0/24",
      version: 4,
    });
    expect(parseCidr("1.2.3.4")).toEqual({
      network: "1.2.3.4",
      prefix: 32,
      cidr: "1.2.3.4/32",
      version: 4,
    });
    expect(parseCidr("2001:db8::1/64")).toEqual({
      network: "2001:db8::",
      prefix: 64,
      cidr: "2001:db8::/64",
      version: 6,
    });
    expect(canonicalCidr("2001:0db8:0:0:0:0:0:1/64")).toBe("2001:db8::/64");
  });

  it("computes network addresses and matching", () => {
    expect(networkAddress("1.2.3.4", 24)).toBe("1.2.3.0");
    expect(networkAddress("2001:db8::1", 64)).toBe("2001:db8::");
    expect(contains("2001:db8::", 64, "2001:db8::1")).toBe(true);
    expect(contains("2001:db8::", 64, "2001:db9::1")).toBe(false);
    expect(contains("1.2.3.0", 24, "1.2.3.9")).toBe(true);
  });

  it("rejects invalid prefixes", () => {
    expect(parseCidr("1.2.3.4/33")).toBeNull();
    expect(parseCidr("2001:db8::1/129")).toBeNull();
  });
});
