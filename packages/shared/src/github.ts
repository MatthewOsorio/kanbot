// Server-only: the Kanbot GitHub App's credentials, encrypted at rest (requirements §10, §15).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "./db";
import { settings } from "./db/schema";

/** What GitHub's manifest conversion returns that Kanbot keeps; the owner is the account that created the App. */
export const gitHubApp = z.object({
  id: z.number(),
  slug: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  webhookSecret: z.string().nullable(),
  pem: z.string(),
  ownerId: z.number(),
  ownerLogin: z.string(),
});
export type GitHubApp = z.infer<typeof gitHubApp>;

function key(): Buffer {
  const k = Buffer.from(process.env.KANBOT_ENCRYPTION_KEY ?? "", "base64");
  if (k.length !== 32)
    throw new Error("KANBOT_ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  return k;
}

/** AES-256-GCM; the result is base64 of iv (12) + tag (16) + ciphertext. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

/** Throws if the value was tampered with or encrypted under another key. */
export function decrypt(value: string): string {
  const b = Buffer.from(value, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export async function loadGitHubApp(db: Pick<Db, "select">): Promise<GitHubApp | null> {
  const [s] = await db.select({ app: settings.githubApp }).from(settings).where(eq(settings.id, 1));
  return s?.app ? gitHubApp.parse(JSON.parse(decrypt(s.app))) : null;
}

/** Saves the App only if none is stored yet; returns false when one already was (a second setup). */
export async function saveGitHubApp(tx: Tx | Db, app: GitHubApp): Promise<boolean> {
  const githubApp = encrypt(JSON.stringify(gitHubApp.parse(app)));
  const rows = await tx
    .insert(settings)
    .values({ id: 1, githubApp })
    .onConflictDoUpdate({
      target: settings.id,
      set: { githubApp, updatedAt: new Date() },
      setWhere: sql`${settings.githubApp} is null`,
    })
    .returning({ id: settings.id });
  return rows.length > 0;
}
