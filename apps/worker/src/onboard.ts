// Onboarding's worker steps (requirements §10): clone the repo and detect its commands (steps 3–4), and
// the baseline run (step 5). The web app queues them in projects.onboarding; the owner does the rest.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectConfigOf, projects, publish, type Db } from "@kanbot/shared/db";
import {
  decryptEnv,
  encryptEnv,
  getRepo,
  gitAuth,
  loadGitHubApp,
  repoToken,
} from "@kanbot/shared/github";
import { detect, ENV_EXAMPLES, envNames, type Onboarding } from "@kanbot/shared/onboarding";
import { git, loadProjectConfig, removeWorktree } from "@kanbot/shared/repo";
import { eq, sql } from "drizzle-orm";
import { redactText } from "./runtime/replay";
import { openEnv, runBaseline } from "./commands";
import { projectImage } from "./docker";
import { worktreesRoot } from "./worktree";

/** Where clones live: KANBOT_REPOS_DIR (compose sets it), else `.kanbot-repos` at the repo root (`pnpm dev`). */
const reposDir = () =>
  resolve(
    process.env.KANBOT_REPOS_DIR ||
      fileURLToPath(new URL("../../../.kanbot-repos", import.meta.url)),
  );

type Project = typeof projects.$inferSelect;

async function setOnboarding(
  db: Db,
  id: string,
  onboarding: Onboarding,
  more: Partial<Project> = {},
) {
  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({ ...more, onboarding })
      .where(eq(projects.id, id));
    await publish(tx, id, { type: "project.onboarding" });
  });
}

/**
 * Runs the next queued onboarding step, if any; returns whether there was one. One at a time: the worker is
 * the only one (its advisory lock), and a step left `running` by a crash is re-queued on start.
 */
export async function onboardNext(db: Db): Promise<boolean> {
  const [p] = await db
    .update(projects)
    .set({ onboarding: sql`jsonb_set(${projects.onboarding}, '{state}', '"running"')` })
    .where(
      eq(
        projects.id,
        sql`(select id from projects where onboarding->>'state' = 'queued' order by created_at limit 1)`,
      ),
    )
    .returning();
  if (!p) return false;
  const step = p.onboarding!.step;
  try {
    if (step === "clone") await clone(db, p);
    else if (step === "baseline") await baseline(db, p);
    else throw new Error(`Onboarding step ${step} isn't the worker's`);
  } catch (e) {
    console.error(`onboarding ${p.keyPrefix} (${step}) failed`, e);
    await setOnboarding(db, p.id, {
      ...p.onboarding!,
      state: "failed",
      error: (e as Error).message,
    });
  }
  return true;
}

/** A step a restart interrupted goes back in the queue. */
export const requeueOnboarding = (db: Db) =>
  db
    .update(projects)
    .set({ onboarding: sql`jsonb_set(${projects.onboarding}, '{state}', '"queued"')` })
    .where(sql`${projects.onboarding}->>'state' = 'running'`);

/** Steps 3–4: clone (or fetch, on a retry) with an installation token that is never written to disk. */
async function clone(db: Db, p: Project) {
  const app = await loadGitHubApp(db);
  if (!app) throw new Error("No GitHub App is connected");
  const token = await repoToken(app, p.githubOwner!, p.githubRepo!);
  const info = await getRepo(token, p.githubOwner!, p.githubRepo!);
  const auth = gitAuth(token);
  const root = reposDir();
  const dir = join(root, p.keyPrefix.toLowerCase());
  await mkdir(root, { recursive: true });
  if (existsSync(join(dir, ".git"))) {
    // A retry, or a project re-added under the same key: Kanbot's own clone, so it's reset to GitHub's.
    await git(dir, ["fetch", "origin", info.defaultBranch], auth);
    await git(dir, ["checkout", "--force", "-B", info.defaultBranch, "FETCH_HEAD"]);
  } else await git(root, ["clone", "--", info.cloneUrl, dir], auth);

  const branch = info.defaultBranch;
  const config = await loadProjectConfig(dir, branch);
  const files = (await git(dir, ["ls-tree", "-r", "--name-only", branch]))
    .split("\n")
    .filter(Boolean);
  const example = ENV_EXAMPLES.find((f) => files.includes(f));
  const wanted = ["package.json", "requirements.txt", "pyproject.toml", example].filter(
    (f): f is string => !!f && files.includes(f),
  );
  const text = new Map(
    await Promise.all(
      wanted.map(async (f) => [f, await git(dir, ["show", `${branch}:${f}`])] as const),
    ),
  );
  const found = detect(files, (f) => text.get(f) ?? "");
  // .kanbot/project.yml and the devcontainer win; detection fills what they leave out.
  const commands = Object.fromEntries(
    Object.entries({ ...found.commands, ...config.commands }).filter(([, v]) => v),
  );
  await setOnboarding(
    db,
    p.id,
    { step: "commands", state: "waiting" },
    {
      repoPath: dir,
      defaultBranch: branch,
      commands,
      testGlobs: config.testGlobs.length ? config.testGlobs : found.testGlobs,
      hotspots: config.hotspots,
      image: config.image ?? (config.dockerfile ? null : (found.image ?? null)),
      dockerfile: config.dockerfile ?? null,
      // The example file's names, empty for the owner to fill (step 4); values set before (a retry) stay.
      env: encryptEnv({
        ...Object.fromEntries(envNames(text.get(example!) ?? "").map((n) => [n, ""])),
        ...decryptEnv(p.env),
      }),
    },
  );
}

/** Step 5: install, build, lint and test on the default branch, in a throwaway worktree. */
async function baseline(db: Db, p: Project) {
  const config = await projectConfigOf(db, p);
  const image = await projectImage(p.repoPath!, p.defaultBranch, config, p.keyPrefix);
  const path = join(worktreesRoot(p.repoPath!), "_baseline");
  if (existsSync(path)) await removeWorktree(p.repoPath!, path);
  await git(p.repoPath!, ["worktree", "add", "--detach", path, p.defaultBranch]);
  const env = await openEnv(decryptEnv(p.env));
  try {
    const result = await runBaseline(config.commands, path, image, env);
    // The output is shown on the setup page: no env var values in it (§14).
    for (const r of Object.values(result)) r.output = redactText(r.output, Object.values(env.vars));
    await setOnboarding(db, p.id, { step: "baseline", state: "waiting" }, { baseline: result });
  } finally {
    await env.dispose();
    await removeWorktree(p.repoPath!, path);
  }
}
