// Ship (requirements §4, FR-43): after Captain Ship-It's run, the worker (never an agent) pushes the
// ticket branch and opens or updates its PR with the App's installation token.
import { type Db, git, gitAuth, loadGitHubApp, repoToken, upsertPr } from "@kanbot/shared/server";

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

export type Conflict = { files: string[]; diff: string };

const isAncestor = (cwd: string, a: string, b: string) =>
  git(cwd, ["merge-base", "--is-ancestor", a, b]).then(
    () => true,
    () => false,
  );

/**
 * FR-51: replays the branch's own commits onto `onto`. Authors are kept; the committer is Kanbot. A conflict aborts the
 * rebase (the worktree is left as it was) and returns the conflicted files and their hunks.
 * shortcut: the hunks are cut at 400 lines; show them side by side when the side-by-side diff exists (§16).
 */
export async function rebaseBranch(
  wt: { path: string; branch: string },
  onto: string,
): Promise<{ rebased: boolean; conflict?: Conflict }> {
  if (!wt.branch.startsWith("kanbot/")) throw new Error(`Refusing to rebase ${wt.branch}`);
  if (await isAncestor(wt.path, onto, "HEAD")) return { rebased: false };
  // shortcut: a worktree with uncommitted work is left behind main (autostash can exit 0 with a conflicted pop); the next clean run rebases it.
  if ((await git(wt.path, ["status", "--porcelain"])).trim()) return { rebased: false };
  try {
    await git(wt.path, ["rebase", onto], {
      GIT_COMMITTER_NAME: "Kanbot",
      GIT_COMMITTER_EMAIL: "kanbot@localhost",
    });
    return { rebased: true };
  } catch (e) {
    const files = (await git(wt.path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    if (!files.length) {
      await git(wt.path, ["rebase", "--abort"]).catch(() => {});
      throw e;
    }
    const diff = (await git(wt.path, ["diff"]).catch(() => ""))
      .split("\n")
      .slice(0, 400)
      .join("\n");
    await git(wt.path, ["rebase", "--abort"]);
    return { rebased: false, conflict: { files, diff } };
  }
}

/** The artifact text for a conflict (shown on the ticket, FR-51). */
export const conflictMarkdown = (onto: string, c: Conflict) =>
  `Rebasing this branch onto \`${onto}\` hit conflicts in ${c.files.map((f) => `\`${f}\``).join(", ")}. Nothing was changed. Resolve it on the branch, then move the ticket on.\n\n\`\`\`diff\n${c.diff.replaceAll("```", "'''")}\n\`\`\``;

/**
 * The only force-push in the system (FR-51): a rebased `kanbot/*` branch, with a lease on what GitHub had when we
 * last fetched it, so anyone's push in between wins and the next run reports it.
 */
export async function pushRebased(
  db: Db,
  p: { githubOwner: string; githubRepo: string },
  wt: { path: string; branch: string },
  remoteSha: string,
) {
  if (!wt.branch.startsWith("kanbot/")) throw new Error(`Refusing to push ${wt.branch}`);
  const token = await appToken(db, p);
  await git(
    wt.path,
    [
      "push",
      `--force-with-lease=refs/heads/${wt.branch}:${remoteSha}`,
      "origin",
      `HEAD:refs/heads/${wt.branch}`,
    ],
    gitAuth(token),
  );
  return (await git(wt.path, ["rev-parse", "HEAD"])).trim();
}

/**
 * FR-48 + FR-51: brings a ticket's worktree up to date: the owner's pushes first (when the ticket has a PR), then the
 * default branch. A rebased PR branch is force-pushed with a lease. A conflict leaves the worktree as it was.
 */
export async function keepCurrent(
  db: Db,
  gh: { githubOwner: string; githubRepo: string } | null,
  hasPr: boolean,
  wt: { path: string; branch: string },
  defaultBranch: string,
): Promise<{ pushedSha?: string; conflict?: Conflict & { onto: string } }> {
  const pulled = gh && hasPr ? await pullBranch(db, gh, wt) : null;
  if (pulled?.conflict) return { conflict: { onto: `${wt.branch} on GitHub`, ...pulled.conflict } };
  const r = await rebaseBranch(wt, defaultBranch);
  if (r.conflict) return { conflict: { onto: defaultBranch, ...r.conflict } };
  if (r.rebased && gh && pulled)
    return { pushedSha: await pushRebased(db, gh, wt, pulled.remoteSha) };
  return {};
}

/**
 * FR-48: before a run on a ticket with a PR, take the commits pushed to its branch on GitHub (the owner's own).
 * Fast-forwards when Kanbot has nothing new; when both have commits, Kanbot's are replayed on top of the owner's, so
 * the owner's commits are never rewritten. Returns GitHub's head (the lease for a later push) and any conflict.
 */
export async function pullBranch(
  db: Db,
  p: { githubOwner: string; githubRepo: string },
  wt: { path: string; branch: string },
): Promise<{ remoteSha: string; conflict?: Conflict }> {
  const token = await appToken(db, p);
  await git(wt.path, ["fetch", "-q", "origin", `refs/heads/${wt.branch}`], gitAuth(token));
  const remoteSha = (await git(wt.path, ["rev-parse", "FETCH_HEAD"])).trim();
  if (await isAncestor(wt.path, remoteSha, "HEAD")) return { remoteSha };
  if (await isAncestor(wt.path, "HEAD", remoteSha)) {
    await git(wt.path, ["merge", "-q", "--ff-only", remoteSha]);
    return { remoteSha };
  }
  const { conflict } = await rebaseBranch(wt, remoteSha);
  return { remoteSha, conflict };
}
