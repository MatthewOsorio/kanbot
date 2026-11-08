// Ship (requirements §4, FR-43): after Captain Ship-It's run, the worker (never an agent) pushes the
// ticket branch and opens or updates its PR with the App's installation token.
import type { Db } from "@kanbot/shared/db";
import { gitAuth, loadGitHubApp, repoToken, upsertPr } from "@kanbot/shared/github";
import { git } from "@kanbot/shared/repo";

export type ShippedPr = { number: number; url: string; headSha: string };

export async function pushAndOpenPr(
  db: Db,
  p: { githubOwner: string; githubRepo: string; defaultBranch: string },
  t: { key: string; title: string; prNumber: number | null },
  wt: { path: string; branch: string },
  description: string,
): Promise<ShippedPr> {
  if (!wt.branch.startsWith("kanbot/")) throw new Error(`Refusing to push ${wt.branch}`);
  const app = await loadGitHubApp(db);
  if (!app) throw new Error("No GitHub App is connected");
  const token = await repoToken(app, p.githubOwner, p.githubRepo);
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
