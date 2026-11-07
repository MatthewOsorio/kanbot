import { writeFileSync } from "node:fs";
import { createDb } from "@kanbot/shared/db";
import { prepareTestDatabase } from "@kanbot/shared/db/testing";
import { saveGitHubApp } from "@kanbot/shared/github";
import { SESSION_COOKIE, signSession } from "../lib/auth";
import { AUTH_STATE, TEST_DATABASE_URL } from "../playwright.config";

export const OWNER_ID = 4242;

/**
 * Creates the e2e database if missing and brings it to the latest migration, stores a fake GitHub App
 * (kept if one is already there), and saves the owner's signed session for every spec to use.
 */
export default async function globalSetup() {
  await prepareTestDatabase(TEST_DATABASE_URL);
  const db = createDb(TEST_DATABASE_URL);
  await saveGitHubApp(db, {
    id: 1,
    slug: "kanbot-e2e",
    clientId: "Iv1.e2e",
    clientSecret: "e2e",
    webhookSecret: null,
    pem: "e2e",
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
}
