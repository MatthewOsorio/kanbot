import type { RunState, StatusFlag } from "./schemas";

/** Terminal run states, i.e. what a run can end as. */
export type RunOutcome = Exclude<RunState, "queued" | "running">;

/**
 * What happens to a ticket when its run ends (requirements §3 transition table), first match wins.
 * `to: null` keeps the ticket where it is. M2 wires the Planning rows and the Blocked rows;
 * M3 adds the build-loop rows (In Progress → Code Review → QA, bounce-backs).
 */
export const RUN_RULES: readonly {
  column: string; // column slug, or "*" for any agent column
  outcome: RunOutcome;
  to: string | null;
  flag: StatusFlag;
}[] = [
  { column: "planning", outcome: "succeeded", to: null, flag: "plan_ready" },
  { column: "*", outcome: "awaiting_input", to: "blocked", flag: "needs_input" },
  { column: "*", outcome: "failed", to: "blocked", flag: "failed" },
  { column: "*", outcome: "timed_out", to: "blocked", flag: "failed" },
  { column: "*", outcome: "budget_exceeded", to: "blocked", flag: "failed" },
  // Crash or API outage: stay put and offer Retry (§8 crash recovery).
  { column: "*", outcome: "interrupted", to: null, flag: "failed" },
  // Cancelled runs were stopped by a move or by the owner; the ticket stays wherever that put it.
  { column: "*", outcome: "cancelled", to: null, flag: "none" },
];

export function afterRun(
  column: string,
  outcome: RunOutcome,
): { to: string | null; flag: StatusFlag } {
  const rule = RUN_RULES.find(
    (r) => (r.column === column || r.column === "*") && r.outcome === outcome,
  );
  // No rule yet (e.g. In Progress success before M3): stay put, clear the flag.
  if (!rule) return { to: null, flag: "none" };
  return { to: rule.to === column ? null : rule.to, flag: rule.flag };
}
