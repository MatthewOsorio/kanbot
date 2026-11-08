import { generateKeyPairSync, randomBytes } from "node:crypto";
import { settings, type Db } from "@kanbot/shared/db";
import { saveGitHubApp } from "@kanbot/shared/github";

/** Points the worker at a GitHub stub and stores a test App, replacing what the shared test database holds. */
export async function connectTestApp(db: Db, stubUrl: string) {
  process.env.KANBOT_GITHUB_API = stubUrl;
  process.env.KANBOT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  await db.update(settings).set({ githubApp: null });
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  await saveGitHubApp(db, {
    id: 1,
    slug: "kanbot-test",
    clientId: "c",
    clientSecret: "s",
    webhookSecret: null,
    pem,
    ownerId: 1,
    ownerLogin: "octo",
  });
}
