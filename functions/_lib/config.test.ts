/** 共享配置模块冒烟测试：契约常量在两端可读取。 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANG,
  GATE_COOKIE,
  LANG_COOKIE,
  ROOT_DOMAIN,
  SESSION_COOKIE,
  SUPPORTED_LANGS,
} from "./config";

describe("shared config", () => {
  it("has the expected shared constants", () => {
    expect(ROOT_DOMAIN).toBe("limooo.cn");
    expect(DEFAULT_LANG).toBe("en-us");
    expect(SUPPORTED_LANGS).toContain("zh-cn");
    expect(GATE_COOKIE).toBe("__gate");
    expect(SESSION_COOKIE).toBe("limooo_session");
    expect(LANG_COOKIE).toBe("user_lang_preference");
  });
});
