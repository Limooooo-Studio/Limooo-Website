/** 语言 cookie 的全站共享行为（Domain=.limooo.cn，主域与所有子域一致）。 */

import { describe, expect, it } from "vitest";
import { detectLang, langCookieHeader } from "./routing";

function req(host: string, cookie?: string, accept?: string): Request {
  const headers: Record<string, string> = { Host: host };
  if (cookie) headers.Cookie = cookie;
  if (accept) headers["Accept-Language"] = accept;
  return new Request(`https://${host}/`, { headers });
}

describe("detectLang reads the shared language cookie", () => {
  it("main domain reads the cookie", () => {
    expect(detectLang(req("limooo.cn", "user_lang_preference=ja-jp", "en-US"))).toBe("ja-jp");
  });

  it("all *.limooo.cn subdomains share one cookie (visitor / account / status / images)", () => {
    for (const host of [
      "visitor.limooo.cn",
      "account.limooo.cn",
      "status.limooo.cn",
      "images.limooo.cn",
      "auth.limooo.cn",
      "services.limooo.cn",
      "some-future-sub.limooo.cn",
    ]) {
      expect(detectLang(req(host, "user_lang_preference=ko-kr", "en-US")), host).toBe("ko-kr");
    }
  });

  it("cookie is case-insensitive; invalid values fall back to Accept-Language", () => {
    expect(detectLang(req("visitor.limooo.cn", "user_lang_preference=ZH-CN"))).toBe("zh-cn");
    expect(detectLang(req("visitor.limooo.cn", "user_lang_preference=xx-yy", "ja-JP"))).toBe("ja-jp");
  });

  it("foreign domains do not read the cookie", () => {
    expect(detectLang(req("evil.example.com", "user_lang_preference=ko-kr", "en-US"))).toBe("en-us");
  });

  it("falls back to Accept-Language when no cookie is present", () => {
    expect(detectLang(req("visitor.limooo.cn", undefined, "ko-KR,ko;q=0.9"))).toBe("ko-kr");
  });
});

describe("langCookieHeader domain scope", () => {
  it("both main domain and subdomains set Domain=.limooo.cn", () => {
    for (const host of ["limooo.cn", "visitor.limooo.cn", "images.limooo.cn"]) {
      expect(langCookieHeader(host, "ja-jp"), host).toContain("Domain=.limooo.cn");
    }
  });

  it("Host with a port is handled correctly (local preview)", () => {
    expect(langCookieHeader("limooo.cn:8788", "ja-jp")).toContain("Domain=.limooo.cn");
  });

  it("foreign domains get no Domain attribute", () => {
    expect(langCookieHeader("evil.example.com", "ja-jp")).not.toContain("Domain=");
  });

  it("cookie attributes are complete (Path / Max-Age / SameSite / Secure)", () => {
    const header = langCookieHeader("limooo.cn", "zh-cn");
    expect(header).toContain("user_lang_preference=zh-cn");
    expect(header).toContain("Path=/");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
  });
});
