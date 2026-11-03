import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    env: { KANBOT_RUNTIME: "replay" },
    testTimeout: 20_000,
  },
});
