/** Fernet 双向互通测试：Python 固化的 token 与 WebCrypto 实现互相解密。 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fernetDecrypt, fernetEncrypt } from "./fernet";

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const fixturePath = fileURLToPath(new URL("../../tests/fixtures/fernet_token.txt", import.meta.url));

describe("fernet", () => {
  it("decrypts the Python-generated fixture", async () => {
    const token = readFileSync(fixturePath, "utf8").trim();
    expect(await fernetDecrypt(token, TEST_KEY)).toBe("hello-limooo");
  });

  it("encrypts and decrypts round-trip", async () => {
    const token = await fernetEncrypt("hello-limooo", TEST_KEY);
    expect(await fernetDecrypt(token, TEST_KEY)).toBe("hello-limooo");
  });

  it("rejects a wrong key", async () => {
    const token = await fernetEncrypt("hello-limooo", TEST_KEY);
    await expect(fernetDecrypt(token, "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWZ9")).rejects.toThrow();
  });
});
