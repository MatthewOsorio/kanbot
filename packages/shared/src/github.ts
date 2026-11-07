// Server-only: the Kanbot GitHub App's credentials, encrypted at rest (requirements §10, §15).
import { createCipheriv, createDecipheriv, createSign, randomBytes } from "node:crypto";
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

/** A project's env vars (§10), `projects.env`: encrypted JSON {NAME: value}; null = none. */
export const decryptEnv = (value: string | null): Record<string, string> =>
  value ? (JSON.parse(decrypt(value)) as Record<string, string>) : {};
export const encryptEnv = (env: Record<string, string>) =>
  Object.keys(env).length ? encrypt(JSON.stringify(env)) : null;

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

/** GitHub's REST API; tests point KANBOT_GITHUB_API at a stub. */
const apiBase = () => process.env.KANBOT_GITHUB_API ?? "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One REST call with a bearer token (App JWT or installation token); throws GitHubError on non-2xx. */
export async function gh<T = unknown>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kanbot",
      ...(init.body !== undefined && { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const { message } = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GitHubError(
      res.status,
      `GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${message ?? res.statusText}`,
    );
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

/** The App's own JWT (RS256, 9 minutes, backdated 60 s for clock drift), for /app endpoints. */
export function appJwt(app: Pick<GitHubApp, "id" | "pem">, now = Date.now()) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 600, iss: String(app.id) })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(app.pem, "base64url")}`;
}

/** An installation token (1 hour) for the installation that covers owner/repo. Never stored. */
export async function repoToken(app: GitHubApp, owner: string, repo: string) {
  const jwt = appJwt(app);
  const inst = await gh<{ id: number }>(jwt, `/repos/${owner}/${repo}/installation`);
  return (
    await gh<{ token: string }>(jwt, `/app/installations/${inst.id}/access_tokens`, {
      method: "POST",
    })
  ).token;
}

export type RepoInfo = {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  cloneUrl: string;
};
type ApiRepo = {
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  clone_url: string;
};
const repoInfo = (r: ApiRepo): RepoInfo => ({
  owner: r.owner.login,
  name: r.name,
  defaultBranch: r.default_branch,
  private: r.private,
  cloneUrl: r.clone_url,
});

export async function getRepo(token: string, owner: string, repo: string) {
  return repoInfo(await gh<ApiRepo>(token, `/repos/${owner}/${repo}`));
}

/**
 * Every repo the App's installations can see (onboarding step 2).
 * shortcut: the first 100 repos per installation; page with `page=` if an installation has more.
 */
export async function listAppRepos(app: GitHubApp): Promise<RepoInfo[]> {
  const jwt = appJwt(app);
  const insts = await gh<{ id: number }[]>(jwt, "/app/installations?per_page=100");
  const lists = await Promise.all(
    insts.map(async (i) => {
      const { token } = await gh<{ token: string }>(
        jwt,
        `/app/installations/${i.id}/access_tokens`,
        { method: "POST" },
      );
      return (
        await gh<{ repositories: ApiRepo[] }>(token, "/installation/repositories?per_page=100")
      ).repositories;
    }),
  );
  return lists.flat().map(repoInfo);
}
