// Onboarding a GitHub repo, the owner's side (requirements §10 steps 2 and 4–7, 10). The worker clones
// and runs the baseline (apps/worker/src/onboard.ts); this file only calls GitHub's API, never git.
import type { createProjectBody, onboardingActionBody } from "@kanbot/shared";
import { projectConfigOf, projects, publish, qaReady } from "@kanbot/shared/db";
import {
  GitHubError,
  getRepo,
  gh,
  listAppRepos,
  loadGitHubApp,
  repoToken,
  workflowFiles as repoWorkflows,
  type GitHubApp,
} from "@kanbot/shared/github";
import {
  branchProtection,
  missingRules,
  protectionRules,
  QA_SETUP_MESSAGE,
  STARTER_CHECK,
  STARTER_WORKFLOW_PATH,
  starterWorkflow,
  type Onboarding,
} from "@kanbot/shared/onboarding";
import { eq, isNotNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { HttpError, notFound } from "./api";
import { db } from "./db";
import { createProject, envView, patchProject } from "./projects";

type Project = typeof projects.$inferSelect;

export async function requireApp(): Promise<GitHubApp> {
  const app = await loadGitHubApp(db);
  if (!app) throw new HttpError(409, "no_github_app", "Connect GitHub first");
  return app;
}

/** GitHub's errors reach the owner as 502 with GitHub's message (e.g. a 403 on a private repo's protection). */
export async function github<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GitHubError) throw new HttpError(502, "github", e.message);
    throw e;
  }
}

/** Step 2: the repos the App can see, and which of them are already projects. */
export async function listRepos() {
  const app = await requireApp();
  const [repos, taken] = await Promise.all([
    github(() => listAppRepos(app)),
    db
      .select({ owner: projects.githubOwner, repo: projects.githubRepo })
      .from(projects)
      .where(isNotNull(projects.githubRepo)),
  ]);
  const used = new Set(taken.map((t) => `${t.owner}/${t.repo}`.toLowerCase()));
  return repos.map(({ cloneUrl: _, ...r }) => ({
    ...r,
    taken: used.has(`${r.owner}/${r.name}`.toLowerCase()),
  }));
}

const tokenFor = async (p: Pick<Project, "githubOwner" | "githubRepo">) =>
  github(async () => repoToken(await requireApp(), p.githubOwner!, p.githubRepo!));

const repoPath = (p: Pick<Project, "githubOwner" | "githubRepo">) =>
  `/repos/${p.githubOwner}/${p.githubRepo}`;

async function load(id: string) {
  const [p] = await db.select().from(projects).where(eq(projects.id, id));
  if (!p) throw notFound("Project not found");
  if (!p.githubRepo || !p.onboarding)
    throw new HttpError(409, "not_github", "This project has no GitHub repo");
  return p;
}

async function setOnboarding(id: string, onboarding: Onboarding) {
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ onboarding }).where(eq(projects.id, id));
    await publish(tx, id, { type: "project.onboarding" });
  });
}

/** The setup page's data: the step, the detected settings, the baseline, and what GitHub says for steps 6–7. */
export async function getOnboarding(id: string) {
  const p = await load(id);
  const o = p.onboarding!;
  const settled = o.state === "waiting" && p.repoPath;
  const config = settled ? await projectConfigOf(db, p) : null;
  let workflows: string[] | null = null;
  let protection: { missing: string[] } | { error: string } | null = null;
  if (o.state === "waiting" && (o.step === "ci" || o.step === "protection")) {
    const token = await tokenFor(p);
    if (o.step === "ci") workflows = await workflowFiles(token, p);
    else protection = await readProtection(token, p);
  }
  return {
    id: p.id,
    name: p.name,
    keyPrefix: p.keyPrefix,
    repo: `${p.githubOwner}/${p.githubRepo}`,
    defaultBranch: p.defaultBranch,
    onboarding: o,
    commands: config?.commands ?? null,
    image: config?.image ?? "",
    dockerfile: config?.dockerfile?.file ?? null,
    testGlobs: config?.testGlobs ?? [],
    env: settled ? envView(p) : [],
    baseline: p.baseline,
    workflows,
    protection,
  };
}

const protectionPath = (p: Project) =>
  `${repoPath(p)}/branches/${encodeURIComponent(p.defaultBranch)}/protection`;

/** Which §10 rules the default branch lacks, or GitHub's refusal (a 403 for a private repo on a free plan). */
async function readProtection(
  token: string,
  p: Project,
): Promise<{ missing: string[] } | { error: string }> {
  return gh(token, protectionPath(p))
    .then((r) => ({ missing: missingRules(branchProtection.parse(r)) }))
    .catch((e: unknown) => {
      if (e instanceof GitHubError && e.status === 404) return { missing: missingRules(null) };
      if (e instanceof GitHubError) return { error: e.message };
      throw e;
    });
}

/** The workflow files on the default branch; [] when there are none. */
const workflowFiles = (token: string, p: Project) =>
  repoWorkflows(token, p.githubOwner!, p.githubRepo!, p.defaultBranch);

/** Moves onboarding on; each action is only valid at its step. */
export async function onboardingAction(id: string, body: z.output<typeof onboardingActionBody>) {
  const p = await load(id);
  const o = p.onboarding!;
  const at = (step: Onboarding["step"], state: Onboarding["state"] = "waiting") => {
    if (o.step !== step || o.state !== state)
      throw new HttpError(409, "wrong_step", `Setup is at "${o.step}" (${o.state}), not "${step}"`);
  };
  switch (body.action) {
    case "retry":
      if (o.state !== "failed") throw new HttpError(409, "wrong_step", "Nothing failed");
      await setOnboarding(id, { step: o.step, state: "queued" });
      break;
    case "confirm-commands":
      at("commands");
      await patchProject(id, body.settings);
      // The edits are saved either way; setup moves on once QA has something to run (§4).
      if (!(await qaReady(db, id))) throw new HttpError(400, "qa_setup", QA_SETUP_MESSAGE);
      await setOnboarding(id, { step: "baseline", state: "queued" });
      break;
    case "rerun-baseline":
      at("baseline");
      await setOnboarding(id, { step: "baseline", state: "queued" });
      break;
    case "accept-baseline":
      at("baseline");
      await setOnboarding(id, { step: "ci", state: "waiting" });
      break;
    case "skip-ci":
      at("ci");
      await setOnboarding(id, { step: "protection", state: "waiting" });
      break;
    case "open-ci-pr": {
      at("ci");
      const ciPrUrl = await github(() => openCiPr(p));
      await setOnboarding(id, { step: "protection", state: "waiting", ciPrUrl });
      break;
    }
    case "apply-protection": {
      at("protection");
      const token = await tokenFor(p);
      const now = await readProtection(token, p);
      // Already protected: keep the owner's own rules rather than overwrite them.
      if ("error" in now || now.missing.length)
        await github(async () =>
          gh(token, protectionPath(p), {
            method: "PUT",
            body: protectionRules(await requiredChecks(token, p, o)),
          }),
        );
      await setOnboarding(id, { ...o, step: "ready" });
      break;
    }
    case "override-protection":
      at("protection");
      await setOnboarding(id, { ...o, step: "ready", override: true });
      break;
  }
  return getOnboarding(id);
}

/**
 * The checks branch protection requires: Kanbot's `ci` job when its workflow is there (or its PR is
 * open), else the check runs already reported on the default branch's head (the repo's own CI).
 */
async function requiredChecks(token: string, p: Project, o: Onboarding) {
  if (
    o.ciPrUrl ||
    (await workflowFiles(token, p)).includes(STARTER_WORKFLOW_PATH.split("/").pop()!)
  )
    return [STARTER_CHECK];
  const { check_runs } = await gh<{ check_runs: { name: string }[] }>(
    token,
    `${repoPath(p)}/commits/${encodeURIComponent(p.defaultBranch)}/check-runs?per_page=100`,
  );
  return [...new Set(check_runs.map((c) => c.name))];
}

const CI_BRANCH = "kanbot/onboarding-ci";

/** Step 6: the starter workflow on its own branch, as a PR the owner merges. Safe to repeat. */
async function openCiPr(p: Project) {
  const token = await tokenFor(p);
  const repo = repoPath(p);
  const config = await projectConfigOf(db, p);
  const envNames = envView(p).map((e) => e.name);
  const { object } = await gh<{ object: { sha: string } }>(
    token,
    `${repo}/git/ref/heads/${encodeURIComponent(p.defaultBranch)}`,
  );
  await gh(token, `${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${CI_BRANCH}`, sha: object.sha },
  }).catch((e: unknown) => {
    if (!(e instanceof GitHubError && e.status === 422)) throw e; // 422: the branch is already there
  });
  const existing = await gh<{ sha: string }>(
    token,
    `${repo}/contents/${STARTER_WORKFLOW_PATH}?ref=${CI_BRANCH}`,
  ).catch(() => null);
  await gh(token, `${repo}/contents/${STARTER_WORKFLOW_PATH}`, {
    method: "PUT",
    body: {
      message: "Add Kanbot's starter CI workflow",
      content: Buffer.from(starterWorkflow(config.commands, config.image, envNames)).toString(
        "base64",
      ),
      branch: CI_BRANCH,
      ...(existing && { sha: existing.sha }),
    },
  });
  const open = await gh<{ html_url: string }[]>(
    token,
    `${repo}/pulls?state=open&head=${encodeURIComponent(`${p.githubOwner}:${CI_BRANCH}`)}`,
  );
  if (open[0]) return open[0].html_url;
  const pr = await gh<{ html_url: string }>(token, `${repo}/pulls`, {
    method: "POST",
    body: {
      title: "Add CI for Kanbot",
      head: CI_BRANCH,
      base: p.defaultBranch,
      body: [
        "Kanbot's starter CI: one job, `ci`, running this project's install, build, lint and test commands",
        config.image ? ` in \`${config.image}\`` : "",
        ".",
        envNames.length
          ? `\n\nIt reads this project's env vars from the repo's Actions secrets: add ${envNames.map((n) => `\`${n}\``).join(", ")} under Settings → Secrets and variables → Actions before merging.`
          : "",
        "\n\nBranch protection on the default branch requires the `ci` check, so merge this first.",
      ].join(""),
    },
  });
  return pr.html_url;
}

/** Step 2: a project for a GitHub repo the App can see; the worker then clones it (step 3). */
export async function createGitHubProject(input: z.output<typeof createProjectBody>) {
  const app = await requireApp();
  const [dup] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      sql`lower(${projects.githubOwner}) = lower(${input.githubOwner!}) and lower(${projects.githubRepo}) = lower(${input.githubRepo!})`,
    );
  if (dup)
    throw new HttpError(
      409,
      "repo_taken",
      `${input.githubOwner}/${input.githubRepo} is already a project`,
    );
  const info = await github(async () =>
    getRepo(
      await repoToken(app, input.githubOwner!, input.githubRepo!),
      input.githubOwner!,
      input.githubRepo!,
    ),
  );
  return createProject(input, {
    githubOwner: info.owner,
    githubRepo: info.name,
    defaultBranch: info.defaultBranch,
    onboarding: { step: "clone", state: "queued" },
  });
}
