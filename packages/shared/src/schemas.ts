import { z } from "zod";

export const ticketTypes = ["feature", "bug", "chore", "spike", "epic"] as const;
export const priorities = ["P0", "P1", "P2", "P3"] as const;
export const criterionStatuses = ["open", "pass", "fail"] as const;
export const activityActions = [
  "created",
  "moved",
  "edited",
  "commented",
  "run_started",
  "run_finished",
] as const;
export const criterionSources = ["user", "agent"] as const;
export const authorKinds = ["user", "agent"] as const;
export const statusFlags = [
  "none",
  "running",
  "needs_input",
  "plan_ready",
  "awaiting_approval",
  "waiting_on_ticket",
  "pr_open",
  "failed",
] as const;
export const runStates = [
  "queued",
  "running",
  "awaiting_input",
  "succeeded",
  "changes_requested",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
  "interrupted",
] as const;
/** Non-terminal run states; at most one per ticket (partial unique index on runs). */
export const activeRunStates = ["queued", "running", "awaiting_input"] as const;
export const runEventTypes = ["assistant", "tool_call", "tool_result", "stdout", "system"] as const;
export const artifactKinds = [
  "plan",
  "research",
  "review",
  "test_report",
  "blocker",
  "retro",
  "diff_snapshot",
] as const;

export type TicketType = (typeof ticketTypes)[number];
export type Priority = (typeof priorities)[number];
export type CriterionStatus = (typeof criterionStatuses)[number];
export type ActivityAction = (typeof activityActions)[number];
export type StatusFlag = (typeof statusFlags)[number];
export type RunState = (typeof runStates)[number];
export type RunEventType = (typeof runEventTypes)[number];
export type ArtifactKind = (typeof artifactKinds)[number];

const nonEmpty = <T extends object>(o: T) => Object.keys(o).length > 0;

export const createProjectBody = z.object({
  name: z.string().trim().min(1).max(100),
  keyPrefix: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, "2-10 uppercase letters or digits, starting with a letter"),
  // Passed to git as an argument: a leading "-" would be read as an option (e.g. --output=<file>).
  // The rest is the core of git check-ref-format.
  defaultBranch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
      /^(?![-/])(?!.*(\.\.|@\{|\/\/))[^\s\p{Cc}~^:?*[\\]+(?<![/.])$/u,
      "Not a valid branch name",
    )
    .default("main"),
  // Absolute path to a local checkout; Plan B reads it (read-only). Optional until onboarding clones repos (M4).
  repoPath: z.string().trim().min(1).max(1_000).optional(),
});

const ticketFields = {
  title: z.string().trim().min(1).max(200),
  descriptionMd: z.string().max(50_000),
  type: z.enum(ticketTypes),
  priority: z.enum(priorities),
  labels: z.array(z.string().trim().min(1).max(50)).max(20),
};

export const createTicketBody = z.object({
  ...ticketFields,
  descriptionMd: ticketFields.descriptionMd.default(""),
  type: ticketFields.type.default("feature"),
  priority: ticketFields.priority.default("P2"),
  labels: ticketFields.labels.default([]),
});

export const patchTicketBody = z
  .object(ticketFields)
  .partial()
  .refine(nonEmpty, "No fields to update");

// Fractional-index key (fractional-indexing package); validated server-side in the move handler.
export const moveTicketBody = z.object({
  toColumnId: z.uuid(),
  position: z.string().min(1).max(200),
  // Required to move a ticket whose run is active (FR-24): the run is cancelled first.
  confirmCancel: z.boolean().optional(),
  // Required to start a ticket in In Progress that overlaps an in-flight ticket (§9 "Start anyway").
  startAnyway: z.boolean().optional(),
});

export const createCommentBody = z.object({ bodyMd: z.string().trim().min(1).max(20_000) });

/** "Request changes" on a plan (UC-3): Plan B re-runs at once with this as the instruction. */
export const revisePlanBody = z.object({ requestMd: z.string().trim().min(1).max(10_000) });

export const createCriterionBody = z.object({ text: z.string().trim().min(1).max(1_000) });

export const patchCriterionBody = z
  .object({ text: createCriterionBody.shape.text, status: z.enum(criterionStatuses) })
  .partial()
  .refine(nonEmpty, "No fields to update");
