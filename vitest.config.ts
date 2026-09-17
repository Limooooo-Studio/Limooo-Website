import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Workers 内置模块，Node 侧没有实现；用桩顶上才能加载 status-worker 的测试。
      "cloudflare:sockets": fileURLToPath(
        new URL("./ops/status-worker/src/__mocks__/cloudflare-sockets.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "functions/**/*.test.ts",
      "ops/sync-worker/src/**/*.test.ts",
      "ops/d1-archive/src/**/*.test.ts",
      "ops/status-worker/src/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.venv-build/**",
    ],
  },
});
