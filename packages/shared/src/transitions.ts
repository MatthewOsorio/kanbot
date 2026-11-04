import type { RunState, StatusFlag } from "./schemas";
import type { Verdict } from "./verdict";

/** Terminal run states, i.e. what a run can end as. */
export type RunOutcome = Exclude<RunState, "queued" | "running">;

/** Code Review + QA bounce-backs a ticket may take before it goes to Blocked (FR-23). Per project: M4. */
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
};

export function afterRun(
  column: string,
  outcome: RunOutcome,
  { verdict, bounces = 0 }: { verdict?: Verdict; bounces?: number } = {},
): AfterRun {
  const rule = RUN_RULES.find(
    (r) =>
      (r.column === column || r.column === "*") &&
      r.outcome === outcome &&
      (!r.verdict || r.verdict === verdict),
  );
  // No rule (e.g. a column whose agent ships later): stay put, clear the flag.
  if (!rule) return { to: null, flag: "none", bounce: false };
  if (rule.bounce && bounces >= BOUNCE_LIMIT)
    return { to: "blocked", flag: "failed", bounce: false, reason: "bounce_limit" };
  return { to: rule.to === column ? null : rule.to, flag: rule.flag, bounce: !!rule.bounce };
}
