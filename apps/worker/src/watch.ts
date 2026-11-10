// The GitHub watcher (§10 "The human review loop", FR-44 polling, FR-46, FR-47, FR-48): every 60 s, each shipped
// ticket's PR is read from GitHub, and CI, reviews, merges and closes move the ticket by GITHUB_RULES.
import { afterGitHub, type CiState, type GitHubEvent, type ReviewState } from "@kanbot/shared";
import {
  activeRun,
  checkRuns,
  ciOf,
  columns,
  comments,
  type Db,
  decryptEnv,
  gh,
  jobLogTail,
  listReviews,
  loadGitHubApp,
  logActivity,
  projectConfigOf,
  projects,
  publish,
  type PullRequest,
  removeWorktree,
  repoToken,
  type Review,
  type ReviewComment,
  reviewComments,
  tickets,
  workflowFiles,
} from "@kanbot/shared/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { moveAndStart } from "./finish";
import { storeArtifact } from "./results";
import { redactText } from "./runtime/redact";

const GITHUB = { kind: "agent" as const, name: "GitHub" }; // the timeline shows it as the actor
const WATCHED = ["ship", "pr_review"];

type Watched = {
  ticket: typeof tickets.$inferSelect;
  column: string;
  project: typeof projects.$inferSelect;
};

/** One pass over every watched ticket; returns how many changed. A ticket that fails is retried next tick. */
export async function watchGitHub(db: Db): Promise<number> {
  const rows: Watched[] = await db
    .select({ ticket: tickets, column: columns.slug, project: projects })
    .from(tickets)
    .innerJoin(columns, eq(columns.id, tickets.columnId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(
      and(
        inArray(columns.slug, WATCHED),
        isNotNull(tickets.prNumber),
        isNotNull(projects.githubRepo),
        isNotNull(projects.repoPath), // a GitHub project is cloned at onboarding; worktrees need it
      ),
    );
  // In Ship, only once Captain Ship-It's run pushed (flag pr_open); a failed or running Ship isn't waiting on CI.
  const waiting = rows.filter((r) => r.column === "pr_review" || r.ticket.statusFlag === "pr_open");
  if (!waiting.length) return 0;
  const app = await loadGitHubApp(db);
  if (!app) return 0;
  let changed = 0;
  const tokens = new Map<string, Promise<string>>();
  for (const w of waiting) {
    const { githubOwner: owner, githubRepo: repo } = w.project;
    try {
      if (!tokens.has(w.project.id)) tokens.set(w.project.id, repoToken(app, owner!, repo!));
      const seen = await look(await tokens.get(w.project.id)!, owner!, repo!, w);
      if (await apply(db, w, seen)) changed++;
    } catch (e) {
      tokens.delete(w.project.id); // a token error shouldn't stick for the rest of the tick
      console.error(`watching ${w.project.keyPrefix}-${w.ticket.number} failed`, e);
    }
  }
  return changed;
}

type Seen = {
  head: string;
  ci: CiState;
  event: GitHubEvent | null;
  failed?: { name: string; url?: string; log: string | null };
  reviewState: ReviewState;
  lastReviewId: number | null;
  imported: { review: Review; comments: ReviewComment[] }[];
};

/** Everything GitHub says about the ticket's PR, read before any transaction (GitHub is slow). */
async function look(token: string, owner: string, repo: string, w: Watched): Promise<Seen> {
  const t = w.ticket;
  const pr = await gh<PullRequest>(token, `/repos/${owner}/${repo}/pulls/${t.prNumber}`);
  const head = pr.head?.sha ?? t.headSha ?? "";
  const base = {
    head,
    ci: t.ciState,
    reviewState: t.reviewState,
    lastReviewId: t.lastReviewId,
    imported: [],
  };
  if (pr.merged) return { ...base, event: "merged" };
  if (pr.state === "closed") return { ...base, event: "closed" };

  const runs = await checkRuns(token, owner, repo, head);
  const { state, failed } = ciOf(runs);
  // §10: a repo with no workflows has no CI to wait for.
  const ci: CiState =
    !runs.length && !(await workflowFiles(token, owner, repo, t.branchName ?? head)).length
      ? "none"
      : state;

  const reviews = (await listReviews(token, owner, repo, t.prNumber!)).filter((r) =>
    ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state),
  );
  const latest = reviews.at(-1);
  const reviewState: ReviewState =
    latest?.state === "APPROVED"
      ? "approved"
      : latest?.state === "CHANGES_REQUESTED"
        ? "changes_requested"
        : "none";
  // Requested changes are imported only from PR Review, where they move the ticket (§3).
  const fresh =
    w.column === "pr_review"
      ? reviews.filter((r) => r.state === "CHANGES_REQUESTED" && r.id > (t.lastReviewId ?? 0))
      : [];
  const imported = await Promise.all(
    fresh.map(async (review) => ({
      review,
      comments: await reviewComments(token, owner, repo, t.prNumber!, review.id),
    })),
  );
  const lastReviewId =
    w.column === "pr_review" && reviews.length
      ? Math.max(t.lastReviewId ?? 0, ...reviews.map((r) => r.id))
      : t.lastReviewId;

  const event: GitHubEvent | null =
    ci === "failing"
      ? "ci_failed"
      : imported.length
        ? "changes_requested"
        : ci === "passing" || ci === "none"
          ? "ci_passed"
          : null;
  return {
    head,
    ci,
    event,
    reviewState,
    lastReviewId,
    imported,
    ...(failed && {
      failed: {
        name: failed.name,
        url: failed.html_url,
        log: await jobLogTail(token, owner, repo, failed.id),
      },
    }),
  };
}

/** Writes what was seen and makes the move, in one transaction; skips a ticket that changed meanwhile. */
async function apply(db: Db, w: Watched, s: Seen): Promise<boolean> {
  let removeAfter = null as string | null; // set in the transaction callback
  const changed = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(tickets).where(eq(tickets.id, w.ticket.id)).for("update");
    // Moved by the owner, re-shipped or picked up by an agent since `look`: next tick sees it fresh.
    if (
      !t ||
      t.columnId !== w.ticket.columnId ||
      t.headSha !== w.ticket.headSha ||
      t.statusFlag !== w.ticket.statusFlag ||
      (await activeRun(tx, t.id))
    )
      return false;
    const key = `${w.project.keyPrefix}-${t.number}`;
    const pushed = !!s.head && s.head !== t.headSha;
    const fields = {
      headSha: s.head || t.headSha,
      ciState: s.ci,
      reviewState: s.reviewState,
      lastReviewId: s.lastReviewId,
    };
    // null when the event moves nothing from here, e.g. green CI on a ticket already in PR Review.
    const rule =
      s.event &&
      afterGitHub(w.column, s.event, {
        bounces: t.bounceCount,
        bounceLimit: (await projectConfigOf(tx, w.project)).bounceLimit,
      });
    if (
      !pushed &&
      !rule &&
      s.ci === t.ciState &&
      s.reviewState === t.reviewState &&
      s.lastReviewId === t.lastReviewId
    )
      return false;

    await tx
      .update(tickets)
      .set({
        ...fields,
        ...(rule && {
          statusFlag: rule.flag,
          bounceCount: t.bounceCount + (rule.bounce ? 1 : 0),
        }),
        ...(rule?.to === "backlog" && { worktreePath: null }),
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, t.id));
    // FR-48: someone else pushed to the branch; the next run starts from this head.
    if (pushed && t.headSha) await logActivity(tx, t.id, "pushed", { sha: s.head }, GITHUB);
    if (s.ci !== t.ciState || pushed)
      await logActivity(
        tx,
        t.id,
        "ci_changed",
        { from: t.ciState, to: s.ci, ...(s.failed && { check: s.failed.name }) },
        GITHUB,
      );
    for (const { review, comments: inline } of s.imported) {
      const by = `**@${review.user?.login ?? "someone"} on GitHub** requested changes`;
      const rows = [
        { ticketId: t.id, bodyMd: review.body?.trim() ? `${by}:\n\n${review.body}` : `${by}.` },
        ...inline.map((c) => ({
          ticketId: t.id,
          bodyMd: `${by} on \`${c.path}${c.line ? `:${c.line}` : ""}\`:\n\n${c.body}`,
          file: c.path,
          line: c.line,
        })),
      ];
      const added = await tx.insert(comments).values(rows).returning({ id: comments.id });
      await logActivity(
        tx,
        t.id,
        "review_imported",
        { reviewId: review.id, by: review.user?.login, comments: added.length },
        GITHUB,
      );
      for (const c of added)
        await publish(tx, t.projectId, {
          type: "comment.created",
          ticketId: t.id,
          commentId: c.id,
        });
    }
    if (s.event === "merged")
      await logActivity(tx, t.id, "pr_merged", { number: t.prNumber }, GITHUB);
    if (s.event === "closed")
      await logActivity(tx, t.id, "pr_closed", { number: t.prNumber }, GITHUB);
    if (rule && s.event === "ci_failed") {
      const env = Object.values(decryptEnv(w.project.env));
      const log = s.failed?.log ? redactText(s.failed.log, env).replaceAll("```", "'''") : null;
      await storeArtifact(tx, t, null, {
        kind: "test_report",
        title: `CI failed: ${s.failed?.name ?? "a check"}`,
        markdown: [
          `CI failed on the PR's head \`${s.head.slice(0, 7)}\`: **${s.failed?.name ?? "a check"}**${s.failed?.url ? ` ([on GitHub](${s.failed.url}))` : ""}. Fix it; Kanbot ships the branch again after review and QA.`,
          log
            ? `The end of its log:\n\n\`\`\`\n${log}\n\`\`\``
            : "Its log isn't available; open the check on GitHub.",
        ].join("\n\n"),
      });
    }
    await publish(tx, t.projectId, {
      type: "ticket.updated",
      ticketId: t.id,
      fields: Object.keys(fields),
    });
    if (rule?.to) {
      const cols = await tx.select().from(columns).where(eq(columns.projectId, t.projectId));
      const from = cols.find((c) => c.id === t.columnId)!;
      const next = cols.find((c) => c.slug === rule.to)!;
      await moveAndStart(tx, t, from, next, GITHUB, rule.bounce);
      if (rule.to === "pr_review")
        await publish(tx, t.projectId, {
          type: "notification",
          kind: "pr_review",
          ticketId: t.id,
          message: `${key}: PR #${t.prNumber} is ready for your review`,
        });
      if (rule.to === "backlog" && t.worktreePath) removeAfter = t.worktreePath;
    }
    return true;
  });
  // §10: a closed PR's ticket loses its worktree; the branch stays.
  if (removeAfter && w.project.repoPath) await removeWorktree(w.project.repoPath, removeAfter);
  return changed;
}
