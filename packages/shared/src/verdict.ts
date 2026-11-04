import { z } from "zod";
import { artifactKinds, type RunState } from "./schemas";

export const verdicts = ["success", "changes_requested", "failed", "needs_input"] as const;
export type Verdict = (typeof verdicts)[number];

/**
 * The `report_result` payload (requirements §8). Each milestone adds the fields its agents use:
 * M2 Plan B's, M3 touchPaths (Plan B), comments + crossTicketRisks (Nancy), criteriaResults (Testy).
 * M5 adds proposedTickets.
 */
export const verdictShape = {
  verdict: z.enum(verdicts),
  summary: z.string().trim().min(1).max(5_000),
  artifacts: z
    .array(
      z.object({
        kind: z.enum(artifactKinds),
        title: z.string().trim().min(1).max(200),
        markdown: z.string().min(1).max(200_000),
      }),
    )
    .max(10)
    .default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  questions: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  /** Plan B: repo-relative files or globs the change is expected to touch (§9 touch set). */
  touchPaths: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  /** Nancy: review line comments. */
  comments: z
    .array(
      z.object({
        file: z.string().trim().min(1).max(500),
        line: z.number().int().positive().max(2_147_483_647).optional(), // Postgres integer
        body: z.string().trim().min(1).max(5_000),
      }),
    )
    .max(50)
    .default([]),
  /** Testy: pass/fail per acceptance criterion, by the id shown in the context. */
  criteriaResults: z
    .array(
      z.object({
        criterionId: z.string().min(1).max(100),
        status: z.enum(["pass", "fail"]),
        note: z.string().max(2_000).optional(),
      }),
    )
    .max(30)
    .default([]),
  /** Nancy: contract changes that affect another in-flight ticket (§9 cross-ticket review). */
  crossTicketRisks: z
    .array(
      z.object({
        ticket: z.string().trim().min(1).max(30),
        kind: z.string().trim().min(1).max(50),
        severity: z.enum(["warning", "blocking"]),
        description: z.string().trim().min(1).max(2_000),
      }),
    )
    .max(20)
    .default([]),
};
export const verdictPayload = z.object(verdictShape);
export type VerdictPayload = z.output<typeof verdictPayload>;

export const stateForVerdict: Record<Verdict, RunState> = {
  success: "succeeded",
  changes_requested: "changes_requested",
  failed: "failed",
  needs_input: "awaiting_input",
};
