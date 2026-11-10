// Ship (requirements §4, FR-43): after Captain Ship-It's run, the worker (never an agent) pushes the
// ticket branch and opens or updates its PR with the App's installation token.
import type { Db } from "@kanbot/shared/db";
import { gitAuth, loadGitHubApp, repoToken, upsertPr } from "@kanbot/shared/github";
import { git } from "@kanbot/shared/repo";

export type ShippedPr = { number: number; url: string; headSha: string };

/** The App's token for the repo; a run that needs GitHub can't go on without one. */
async function appToken(db: Db, p: { githubOwner: string; githubRepo: string }) {
  const app = await loadGitHubApp(db);
  if (!app) throw new Error("No GitHub App is connected");
  return repoToken(app, p.githubOwner, p.githubRepo);
}

export async function pushAndOpenPr(
  db: Db,
  p: { githubOwner: string; githubRepo: string; defaultBranch: string },
  t: { key: string; title: string; prNumber: number | null },
  wt: { path: string; branch: string },
  description: string,
): Promise<ShippedPr> {
  if (!wt.branch.startsWith("kanbot/")) throw new Error(`Refusing to push ${wt.branch}`);
  const token = await appToken(db, p);
  const headSha = (await git(wt.path, ["rev-parse", "HEAD"])).trim();
  // Never forced: a branch the owner pushed to on GitHub refuses this push rather than losing their commits (FR-48).
  await git(wt.path, ["push", "origin", `HEAD:refs/heads/${wt.branch}`], gitAuth(token));
  const pr = await upsertPr(token, p.githubOwner, p.githubRepo, {
    number: t.prNumber,
    title: `${t.key}: ${t.title}`,
    body: `${description.trim()}\n\n---\nKanbot ticket ${t.key}. Opened by Kanbot; merging needs a human approval.`,
    head: wt.branch,
    base: p.defaultBranch,
  });
  return { number: pr.number, url: pr.html_url, headSha };
}

/**
 * §9: before each run, bring the clone's default branch up to GitHub's (merged PRs), so new ticket branches and
 * diffs start from it. Fast-forward only; the clone is Kanbot's, agents only read it.
 * shortcut: best effort (a failed fetch or a diverged default branch only warns), until M6's rebase loop (FR-51) reports it.
 */
export async function pullDefaultBranch(
  db: Db,
  p: { githubOwner: string; githubRepo: string; defaultBranch: string; repoPath: string },
) {
  try {
    const app = await loadGitHubApp(db);
    if (!app) return;
    const token = await repoToken(app, p.githubOwner, p.githubRepo);
    const ref = `refs/heads/${p.defaultBranch}`;
    const head = (await git(p.repoPath, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
    // A checked-out branch can't be fetched into; merge it instead.
    if (head === ref) {
      await git(p.repoPath, ["fetch", "-q", "origin", ref], gitAuth(token));
      await git(p.repoPath, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    } else await git(p.repoPath, ["fetch", "-q", "origin", `${ref}:${ref}`], gitAuth(token));
  } catch (e) {
    console.warn(`couldn't update ${p.defaultBranch} in ${p.repoPath} from GitHub`, e);
  }
}

/**
 * FR-48: before a run on a ticket with a PR, take the commits pushed to its branch on GitHub (the owner's own).
 * Fast-forward only, so nobody's commits are rewritten; a branch that diverged stops the run (rebasing is M6, FR-51).
 */
export async function pullBranch(
  db: Db,
  p: { githubOwner: string; githubRepo: string },
  wt: { path: string; branch: string },
) {
  const token = await appToken(db, p);
  await git(wt.path, ["fetch", "-q", "origin", `refs/heads/${wt.branch}`], gitAuth(token));
  const contains = (a: string, b: string) =>
    git(wt.path, ["merge-base", "--is-ancestor", a, b]).then(
      () => true,
      () => false,
    );
  if (await contains("FETCH_HEAD", "HEAD")) return false;
  if (!(await contains("HEAD", "FETCH_HEAD")))
    throw new Error(
      `${wt.branch} on GitHub and Kanbot's worktree both have commits the other lacks. Merge them on the branch by hand, then retry.`,
    );
  await git(wt.path, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
  return true;
}
