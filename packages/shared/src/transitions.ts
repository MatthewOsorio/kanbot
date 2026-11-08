import type { RunState, StatusFlag } from "./schemas";
import type { Verdict } from "./verdict";

/** Terminal run states, i.e. what a run can end as. */
export type RunOutcome = Exclude<RunState, "queued" | "running">;

/** Bounce-backs (checks gate, Code Review, QA) a ticket may take before Blocked (FR-23); the default, per project in Settings. */
export const BOUNCE_LIMIT = 3;

/**
 * What happens to a ticket when its run ends (requirements §3 transition table), first match wins.
 * `to: null` keeps the ticket where it is. `verdict` narrows a row to runs that reported that verdict,
 * so a QA run that *reports* `failed` bounces, while one that crashed or never reported goes to Blocked.
 * `bounce` rows count toward BOUNCE_LIMIT.
 */
export const RUN_RULES: readonly {
  column: string; // column slug, or "*" for any agent column
  outcome: RunOutcome;
  verdict?: Verdict;
  to: string | null;
  flag: StatusFlag;
  bounce?: true;
}[] = [
  { column: "planning", outcome: "succeeded", to: null, flag: "plan_ready" },
  // The build loop (M3).
  { column: "in_progress", outcome: "succeeded", to: "code_review", flag: "none" },
  // The checks gate failed (build, lint or test, run by the worker): Sir Codes-a-Lot goes again (§8).
  {
    column: "in_progress",
    outcome: "changes_requested",
    to: "in_progress",
    flag: "none",
    bounce: true,
  },
  { column: "code_review", outcome: "succeeded", to: "qa", flag: "none" },
  {
    column: "code_review",
    outcome: "changes_requested",
    to: "in_progress",
    flag: "none",
    bounce: true,
  },
  // QA → Ship waits for the owner (approval gate by default); dragging to Ship approves.
  { column: "qa", outcome: "succeeded", to: null, flag: "awaiting_approval" },
  {
    column: "qa",
    outcome: "failed",
    verdict: "failed",
    to: "in_progress",
    flag: "none",
    bounce: true,
  },
  // Ship (M5): the worker pushed and opened the PR; the ticket waits for CI (§10). A branch that no longer
  // builds, lints or tests after Captain Ship-It's edits goes back like the checks gate's failure.
  { column: "ship", outcome: "succeeded", to: null, flag: "pr_open" },
  { column: "ship", outcome: "changes_requested", to: "in_progress", flag: "none", bounce: true },
  // Rubber Duckworth only diagnoses: however its run ends, the ticket waits in Blocked for the owner (§8).
  ...(["succeeded", "failed", "timed_out", "budget_exceeded", "awaiting_input"] as const).map(
    (outcome) => ({ column: "blocked", outcome, to: null, flag: "needs_input" as const }),
  ),
  // Archie's retro is a courtesy: however it ends, a finished ticket stays in Done (failed ones get Retry).
  ...(["succeeded", "failed", "timed_out", "budget_exceeded", "awaiting_input"] as const).map(
    (outcome) => ({
      column: "done",
      outcome,
      to: null,
      flag: outcome === "succeeded" ? ("none" as const) : ("failed" as const),
    }),
  ),
  { column: "*", outcome: "awaiting_input", to: "blocked", flag: "needs_input" },
  { column: "*", outcome: "failed", to: "blocked", flag: "failed" },
  { column: "*", outcome: "timed_out", to: "blocked", flag: "failed" },
  { column: "*", outcome: "budget_exceeded", to: "blocked", flag: "failed" },
  // Crash or API outage: stay put and offer Retry (§8 crash recovery).
  { column: "*", outcome: "interrupted", to: null, flag: "failed" },
  // Cancelled runs were stopped by a move or by the owner; the ticket stays wherever that put it.
  { column: "*", outcome: "cancelled", to: null, flag: "none" },
];

export type AfterRun = {
  to: string | null;
  flag: StatusFlag;
  /** Count this move toward the ticket's bounce limit. */
  bounce: boolean;
  /** Set when the bounce limit turned a bounce into Blocked. */
  reason?: "bounce_limit";
  /** A bounce that stays in its column: the column's agent runs again there. */
  rerun?: true;
};

export function afterRun(
  column: string,
  outcome: RunOutcome,
  {
    verdict,
    bounces = 0,
    bounceLimit = BOUNCE_LIMIT,
  }: { verdict?: Verdict; bounces?: number; bounceLimit?: number } = {},
): AfterRun {
  const rule = RUN_RULES.find(
    (r) =>
      (r.column === column || r.column === "*") &&
      r.outcome === outcome &&
      (!r.verdict || r.verdict === verdict),
  );
  // No rule (e.g. a column whose agent ships later): stay put, clear the flag.
  if (!rule) return { to: null, flag: "none", bounce: false };
  if (rule.bounce && bounces >= bounceLimit)
    return { to: "blocked", flag: "failed", bounce: false, reason: "bounce_limit" };
  if (rule.bounce && rule.to === column)
    return { to: null, flag: rule.flag, bounce: true, rerun: true };
  return { to: rule.to === column ? null : rule.to, flag: rule.flag, bounce: !!rule.bounce };
}

/** What the GitHub watcher saw on a shipped ticket's PR (§10 "The human review loop", FR-46, FR-47). */
export type GitHubEvent = "ci_passed" | "ci_failed" | "changes_requested" | "merged" | "closed";

/** The §3 rows for GitHub's side: only tickets in Ship or PR Review are watched. */
export const GITHUB_RULES: readonly {
  from: readonly string[];
  event: GitHubEvent;
  to: string;
  bounce?: true;
}[] = [
  { from: ["ship"], event: "ci_passed", to: "pr_review" },
  { from: ["ship", "pr_review"], event: "ci_failed", to: "in_progress", bounce: true },
  // The owner's own review isn't counted toward the bounce limit (§3).
  { from: ["pr_review"], event: "changes_requested", to: "in_progress" },
  { from: ["ship", "pr_review"], event: "merged", to: "done" },
  { from: ["ship", "pr_review"], event: "closed", to: "backlog" },
];

/** The move a GitHub event makes, or null when it changes nothing for a ticket in `column`. */
export function afterGitHub(
  column: string,
  event: GitHubEvent,
  { bounces = 0, bounceLimit = BOUNCE_LIMIT }: { bounces?: number; bounceLimit?: number } = {},
): AfterRun | null {
  const rule = GITHUB_RULES.find((r) => r.event === event && r.from.includes(column));
  if (!rule) return null;
  if (rule.bounce && bounces >= bounceLimit)
    return { to: "blocked", flag: "failed", bounce: false, reason: "bounce_limit" };
  return { to: rule.to, flag: "none", bounce: !!rule.bounce };
}
