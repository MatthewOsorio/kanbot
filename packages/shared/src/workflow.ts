/** Default workflow (requirements §3, §4). Seeded per project; editable columns are FR-4 (Later). */
export const DEFAULT_COLUMNS = [
  { slug: "backlog", name: "Backlog", agentSlug: null },
  { slug: "planning", name: "Planning", agentSlug: "plan-b" },
  { slug: "ready", name: "Ready", agentSlug: null },
  { slug: "in_progress", name: "In Progress", agentSlug: "sir-codes-a-lot" },
  { slug: "code_review", name: "Code Review", agentSlug: "nitpick-nancy" },
  { slug: "qa", name: "QA / Testing", agentSlug: "testy-mctestface" },
  { slug: "ship", name: "Ship", agentSlug: "captain-ship-it" },
  { slug: "pr_review", name: "PR Review", agentSlug: null },
  { slug: "done", name: "Done", agentSlug: "archie-the-archivist" },
  { slug: "blocked", name: "Blocked", agentSlug: "rubber-duckworth" },
] as const satisfies readonly { slug: string; name: string; agentSlug: string | null }[];

/** Dr. Rabbit Hole answers spike tickets in Planning, in Plan B's place (UC-10). */
export const RABBIT_HOLE = "dr-rabbit-hole";
/** Agents that no column names: the Agents page and the drawer list them too. */
export const EXTRA_AGENTS = [RABBIT_HOLE] as const;

/** How a run's error starts when the Anthropic API failed; automatic resume and the health check look for it. */
export const ANTHROPIC_API_ERROR = "Anthropic API error";

/** Columns where a ticket is "in flight": the §9 overlap check and Nancy's cross-ticket review. */
export const IN_FLIGHT_COLUMNS = ["in_progress", "code_review", "qa", "ship", "pr_review"];
