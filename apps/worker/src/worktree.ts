import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { branchName, git, type ProjectConfig } from "@kanbot/shared/repo";

const sh = promisify(exec);

/** Columns whose agents work in the ticket's worktree (FR-40); earlier columns use the checkout. */
export const WORKTREE_COLUMNS = new Set(["in_progress", "code_review", "qa"]);

/** Worktrees live beside the checkout, never inside it: `<repo>.kanbot-worktrees/<KEY-n>` (§7). */
export const worktreesRoot = (repoPath: string) => `${resolve(repoPath)}.kanbot-worktrees`;

type Ticket = { key: string; title: string; branchName: string | null };

/**
 * Creates the ticket's worktree and branch on first use, or reuses them (FR-40). Never touches the
 * default branch or any branch outside `kanbot/`. Runs the project's install command after creating.
 */
export async function ensureWorktree(
  repoPath: string,
  defaultBranch: string,
  ticket: Ticket,
  config: ProjectConfig,
): Promise<{ path: string; branch: string; created: boolean }> {
  const branch = ticket.branchName ?? branchName(ticket.key, ticket.title);
  const root = worktreesRoot(repoPath);
  const path = join(root, ticket.key);
  if (!branch.startsWith("kanbot/") || relative(root, path).startsWith(".."))
    throw new Error(`Refusing worktree ${path} on branch ${branch}`);

  if (existsSync(path)) {
    const head = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (head !== branch) throw new Error(`Worktree ${path} is on ${head}, expected ${branch}`);
    return { path, branch, created: false };
  }
  await git(repoPath, ["worktree", "prune"]); // forget worktrees whose folder was deleted
  const exists = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
  await git(
    repoPath,
    exists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, defaultBranch],
  );
  if (config.commands.install) await runCommand(config.commands.install, path);
  return { path, branch, created: true };
}

/** A project command, run by the worker itself (install). Same scrubbed env as agents get. */
async function runCommand(command: string, cwd: string) {
  const { DATABASE_URL: _db, ANTHROPIC_API_KEY: _key, ...env } = process.env;
  await sh(command, {
    cwd,
    env,
    timeout: 10 * 60_000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/** Uncommitted and untracked files (porcelain paths, repo-relative, forward slashes). */
async function dirtyFiles(path: string) {
  const status = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
  return status
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, ""));
}

/** Snapshot before a run, for the post-run checks. */
export async function snapshot(path: string, defaultBranch: string) {
  const [head, main, dirty] = await Promise.all([
    git(path, ["rev-parse", "HEAD"]),
    git(path, ["rev-parse", `refs/heads/${defaultBranch}`]),
    dirtyFiles(path),
  ]);
  return { head: head.trim(), main: main.trim(), dirty };
}

/** Files changed since `base`, committed or not. */
export async function changedSince(path: string, base: string) {
  const [committed, dirty] = await Promise.all([
    git(path, ["diff", "--name-only", base, "HEAD"]),
    dirtyFiles(path),
  ]);
  return [...new Set([...committed.split("\n").filter(Boolean), ...dirty])];
}

/**
 * Post-run checks (requirements §8, §14). Returns why the run must fail, or null. Nothing is reverted:
 * the commits stay on the branch for the owner to inspect.
 */
export async function checkAfterRun(
  wt: { path: string; branch: string },
  defaultBranch: string,
  before: { head: string; main: string; dirty: string[] },
  canEdit: ((rel: string) => boolean) | undefined,
): Promise<string | null> {
  const head = (await git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (head !== wt.branch)
    return `The worktree was switched to ${head}; agents must stay on ${wt.branch}`;
  const after = await snapshot(wt.path, defaultBranch);
  // The owner may commit to the default branch while agents work; only the run's own commits landing
  // there count. (The fence keeps agents from reaching it at all; this is the second check.)
  if (after.main !== before.main) {
    const range = (from: string, to: string) =>
      git(wt.path, ["rev-list", `${from}..${to}`]).then((s) => s.split("\n").filter(Boolean));
    const [onMain, mine] = await Promise.all([
      range(before.main, after.main),
      range(before.head, after.head),
    ]);
    if (onMain.some((c) => mine.includes(c)))
      return `This run's commits reached the default branch ${defaultBranch}`;
  }
  const kept = await git(wt.path, ["merge-base", "--is-ancestor", before.head, after.head])
    .then(() => true)
    .catch(() => false);
  if (!kept) return "Commits that existed before the run were rewritten (amend, reset or rebase)";
  // A run answers only for what it changed: files a previous run left dirty aren't this run's.
  // shortcut: a file that was already dirty and this run edits further isn't caught; hash dirty files if that matters.
  const changed = (await changedSince(wt.path, before.head)).filter(
    (f) => !before.dirty.includes(f),
  );
  const settings = changed.find((f) => f.startsWith(".kanbot/"));
  if (settings) return `Agents may not change Kanbot settings (${settings})`;
  const outside = canEdit && changed.filter((f) => !canEdit(f));
  if (outside?.length)
    return `Changed files outside this agent's edit scope: ${outside.join(", ")}`;
  return null;
}
