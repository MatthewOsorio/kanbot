import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 3100;
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://kanbot:kanbot@localhost:5432/kanbot_test";
// Test-only secrets: global-setup stores a fake GitHub App and signs the owner's session with them, so
// every spec runs signed in (auth is never switched off, requirements §12).
const SECRETS = {
  KANBOT_SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
  KANBOT_ENCRYPTION_KEY: "ZTJlLWVuY3J5cHRpb24ta2V5LTAxMjM0NTY3ODlhYmM=",
};
Object.assign(process.env, SECRETS);
export const AUTH_STATE = "e2e/.auth.json";
// Onboarding (§10) talks to a GitHub stub that global-setup starts; the worker clones into a temp folder.
export const GITHUB_STUB_PORT = 3199;
export const E2E_TMP = join(tmpdir(), "kanbot-e2e");
const GITHUB = {
  KANBOT_GITHUB_API: `http://127.0.0.1:${GITHUB_STUB_PORT}`,
  KANBOT_REPOS_DIR: join(E2E_TMP, "repos"),
};

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://127.0.0.1:${PORT}`, storageState: AUTH_STATE },
  webServer: [
    {
      command: `next dev -H 127.0.0.1 -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      env: { DATABASE_URL: TEST_DATABASE_URL, NEXT_DIST_DIR: ".next-e2e", ...SECRETS, ...GITHUB },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The worker on the replay runtime: agents play fixtures/runs, never the real API (requirements §8).
      command: "node --import tsx src/main.ts",
      cwd: "../worker",
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        KANBOT_RUNTIME: "replay",
        ANTHROPIC_API_KEY: "",
        ...SECRETS,
        ...GITHUB,
      },
      wait: { stdout: /kanbot worker up/ },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
