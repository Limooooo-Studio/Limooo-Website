import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "functions/**/*.test.ts",
      "ops/sync-worker/src/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.venv-build/**",
    ],
  },
});
