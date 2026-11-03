import { defineConfig } from "@playwright/test";

const PORT = 3100;
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://kanbot:kanbot@localhost:5432/kanbot_test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `next dev -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    env: { DATABASE_URL: TEST_DATABASE_URL, NEXT_DIST_DIR: ".next-e2e" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
