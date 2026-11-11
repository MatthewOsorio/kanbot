import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    setupFiles: ["../../packages/shared/src/testing/test-network-guard.ts"],
    env: { KANBOT_RUNTIME: "replay", KANBOT_GITHUB_API: "http://127.0.0.1:9" },
    expect: { requireAssertions: true },
    testTimeout: 30_000,
    // claimNext is global: test files must not claim each other's runs.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      enabled: !!process.env.CI,
      reporter: ["text-summary"],
      thresholds: { statements: 74, branches: 73, functions: 67, lines: 76 },
    },
  },
});
