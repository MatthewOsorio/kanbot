import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    env: { KANBOT_RUNTIME: "replay" },
    testTimeout: 30_000,
    // claimNext is global: test files must not claim each other's runs.
    fileParallelism: false,
  },
});
