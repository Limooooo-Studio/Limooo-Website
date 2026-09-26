/** 语言 cookie 的全站共享行为（Domain=.limooo.cn，主域与所有子域一致）。 */

import { describe, expect, it } from "vitest";
import { detectLang, langCookieHeader } from "./routing";

function req(host: string, cookie?: string, accept?: string): Request {
  const headers: Record<string, string> = { Host: host };
  if (cookie) headers.Cookie = cookie;
  if (accept) headers["Accept-Language"] = accept;
  return new Request(`https://${host}/`, { headers });
}

describe("detectLang 读取共享语言 cookie", () => {
  it("主域读 cookie", () => {
    expect(detectLang(req("limooo.cn", "user_lang_preference=ja-jp", "en-US"))).toBe("ja-jp");
  });

  it("所有 *.limooo.cn 子域都读同一份 cookie（含 visitor / account / status / images）", () => {
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

  it("cookie 大小写不敏感，非法值回退 Accept-Language", () => {
    expect(detectLang(req("visitor.limooo.cn", "user_lang_preference=ZH-CN"))).toBe("zh-cn");
    expect(detectLang(req("visitor.limooo.cn", "user_lang_preference=xx-yy", "ja-JP"))).toBe("ja-jp");
  });

  it("非本站域名不读该 cookie（避免跨站 cookie 被误用）", () => {
    expect(detectLang(req("evil.example.com", "user_lang_preference=ko-kr", "en-US"))).toBe("en-us");
  });

  it("没有 cookie 时按 Accept-Language 判定", () => {
    expect(detectLang(req("visitor.limooo.cn", undefined, "ko-KR,ko;q=0.9"))).toBe("ko-kr");
  });
});

describe("langCookieHeader 下发域", () => {
  it("主域与子域都下发 Domain=.limooo.cn", () => {
    for (const host of ["limooo.cn", "visitor.limooo.cn", "images.limooo.cn"]) {
      expect(langCookieHeader(host, "ja-jp"), host).toContain("Domain=.limooo.cn");
    }
  });

  it("带端口的 Host 也能正确判定（本地预览）", () => {
    expect(langCookieHeader("limooo.cn:8788", "ja-jp")).toContain("Domain=.limooo.cn");
  });

  it("非本站域名不下发 Domain（避免污染其它域）", () => {
    expect(langCookieHeader("evil.example.com", "ja-jp")).not.toContain("Domain=");
  });

  it("cookie 属性完整（Path / Max-Age / SameSite / Secure）", () => {
    const header = langCookieHeader("limooo.cn", "zh-cn");
    expect(header).toContain("user_lang_preference=zh-cn");
    expect(header).toContain("Path=/");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
  });
});
