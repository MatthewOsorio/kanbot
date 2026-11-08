import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-network-guard.ts"],
    env: { KANBOT_GITHUB_API: "http://127.0.0.1:9" },
    expect: { requireAssertions: true },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      enabled: !!process.env.CI,
      reporter: ["text-summary"],
      thresholds: { statements: 42, branches: 32, functions: 35, lines: 43 },
    },
  },
});
