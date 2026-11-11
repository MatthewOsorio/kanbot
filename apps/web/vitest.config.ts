import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname) } },
  test: {
    // e2e/*.spec.ts belong to Playwright.
    include: ["lib/**/*.test.ts", "*.test.ts"],
    setupFiles: ["../../packages/shared/src/testing/test-network-guard.ts"],
    env: { KANBOT_SESSION_SECRET: "unit-test-session-secret-0123456789" },
    expect: { requireAssertions: true },
  },
});
