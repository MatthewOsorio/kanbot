import { z } from "zod";
import { artifactKinds, type RunState } from "./schemas";

export const verdicts = ["success", "changes_requested", "failed", "needs_input"] as const;
export type Verdict = (typeof verdicts)[number];

/**
 * The `report_result` payload (requirements §8). M2 has only the fields Plan B uses; M3 adds
 * comments, criteriaResults and crossTicketRisks, and M5 adds proposedTickets.
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
};
export const verdictPayload = z.object(verdictShape);
export type VerdictPayload = z.output<typeof verdictPayload>;

export const stateForVerdict: Record<Verdict, RunState> = {
  success: "succeeded",
  changes_requested: "changes_requested",
  failed: "failed",
  needs_input: "awaiting_input",
};
