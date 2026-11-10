import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createDb, git, saveGitHubApp, settings } from "@kanbot/shared/server";
import { prepareSampleRepo, prepareTestDatabase, startGitHubStub } from "@kanbot/shared/testing";
import { SESSION_COOKIE, signSession } from "../lib/auth";
import { AUTH_STATE, E2E_TMP, GITHUB_STUB_PORT, TEST_DATABASE_URL } from "../playwright.config";

export const OWNER_ID = 4242;

/**
 * Creates the e2e database if missing and brings it to the latest migration, stores a fake GitHub App
 * (replacing any), starts the GitHub stub with a sample repo to clone, and saves the owner's signed
 * session for every spec to use. Returns the teardown.
 */
export default async function globalSetup() {
  await prepareTestDatabase(TEST_DATABASE_URL);
  await rm(E2E_TMP, { recursive: true, force: true });
  const origin = await prepareSampleRepo(join(E2E_TMP, "origin"));
  // An example env file, so onboarding proposes its names (§10 step 4).
  writeFileSync(join(origin, ".env.example"), "KB_API_KEY=\n");
  await git(origin, ["add", ".env.example"]);
  await git(origin, ["commit", "-q", "-m", "Example env"]);
  const stub = await startGitHubStub({
    owner: "octo",
    repo: "sample",
    cloneUrl: origin,
    port: GITHUB_STUB_PORT,
  });
  const db = createDb(TEST_DATABASE_URL);
  await db.update(settings).set({ githubApp: null });
  await saveGitHubApp(db, {
    id: 1,
    slug: "kanbot-e2e",
    clientId: "Iv1.e2e",
    clientSecret: "e2e",
    webhookSecret: null,
    pem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString(),
    ownerId: OWNER_ID,
    ownerLogin: "e2e-owner",
  });
  await db.$client.end();
  const cookie = {
    name: SESSION_COOKIE,
    value: signSession(OWNER_ID),
    domain: "127.0.0.1",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax" as const,
  };
  writeFileSync(AUTH_STATE, JSON.stringify({ cookies: [cookie], origins: [] }));
  return () => stub.close();
}
