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
  "pr_opened",
  "pr_closed",
  "pr_merged",
  "ci_changed",
  "review_imported",
  "pushed",
] as const;
export const criterionSources = ["user", "agent"] as const;
export const linkKinds = ["blocks", "relates"] as const;
export const linkSources = ["user", "agent"] as const;
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
/** A PR head's CI (FR-46): none = the repo has no workflows. */
export const ciStates = ["none", "pending", "passing", "failing"] as const;
/** The latest GitHub review on the PR (FR-47). */
export const reviewStates = ["none", "approved", "changes_requested"] as const;
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
/** Non-terminal run states; at most one per ticket (partial unique index on runs). `awaiting_input` is terminal (§8 Resume). */
export const activeRunStates = ["queued", "running"] as const;
/** Ended runs that Resume can continue (§8 Resume, UC-7, UC-13). */
export const resumableRunStates: readonly string[] = [
  "awaiting_input",
  "failed",
  "timed_out",
  "budget_exceeded",
  "changes_requested",
  "interrupted",
] satisfies RunState[];
export const runEventTypes = ["assistant", "tool_call", "tool_result", "stdout", "system"] as const;
export const artifactKinds = [
  "plan",
  "research",
  "review",
  "test_report",
  "blocker",
  "retro",
  "diff_snapshot",
  "pr_description",
] as const;

export type TicketType = (typeof ticketTypes)[number];
export type Priority = (typeof priorities)[number];
export type CriterionStatus = (typeof criterionStatuses)[number];
export type ActivityAction = (typeof activityActions)[number];
export type StatusFlag = (typeof statusFlags)[number];
export type CiState = (typeof ciStates)[number];
export type ReviewState = (typeof reviewStates)[number];
export type RunState = (typeof runStates)[number];
export type RunEventType = (typeof runEventTypes)[number];
export type ArtifactKind = (typeof artifactKinds)[number];

const nonEmpty = <T extends object>(o: T) => Object.keys(o).length > 0;

/** A GitHub owner or repo name: letters, digits, `-`, `_`, `.` (never `.` or `..` alone). */
const GITHUB_NAME = /^(?!\.\.?$)[\w.-]+$/;

export const createProjectBody = z
  .object({
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
    // Absolute path to a local checkout; Plan B reads it (read-only). Optional until onboarding clones repos (M5).
    repoPath: z.string().trim().min(1).max(1_000).optional(),
    // A GitHub repo the App can see (§10 onboarding); its default branch comes from GitHub. Used in API paths.
    githubOwner: z.string().regex(GITHUB_NAME).max(100).optional(),
    githubRepo: z.string().regex(GITHUB_NAME).max(100).optional(),
  })
  .refine((b) => !b.githubOwner === !b.githubRepo, "githubOwner and githubRepo go together")
  .refine(
    (b) => !(b.githubRepo && b.repoPath),
    "A project is a GitHub repo or a local folder, not both",
  );

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
  // Moving a ticket that has a plan into Planning needs one of these (409 `has_plan` otherwise):
  // keep the plan as is, or have Plan B revise it with this request.
  keepPlan: z.boolean().optional(),
  requestMd: z.string().trim().min(1).max(10_000).optional(),
  // §3: into Ship before QA passed (409 `skip_gates`), and into Done with an open PR, which closes it (409 `pr_open`).
  confirmSkip: z.boolean().optional(),
  confirmClose: z.boolean().optional(),
});

export const createCommentBody = z.object({ bodyMd: z.string().trim().min(1).max(20_000) });

/** "Request changes" on a plan (UC-3): Plan B re-runs at once with this as the instruction. */
export const revisePlanBody = z.object({ requestMd: z.string().trim().min(1).max(10_000) });
/** Resume (UC-7): the owner's answer to the blocker; empty when nothing needs saying (UC-13). */
export const resumeRunBody = z.object({ answer: z.string().trim().max(10_000).default("") });

/** Pause all (FR-63) and the daily cap (§14). Resuming clears a pause reason Kanbot set itself. */
export const patchSettingsBody = z
  .object({ paused: z.boolean(), dailyBudgetUsd: z.number().min(0).max(10_000) })
  .partial()
  .refine(nonEmpty, "No fields to update");

/** A Docker image reference (§7). It becomes a `docker run` argument, so it may not start with "-". */
export const IMAGE_REF = /^[a-z0-9][\w./:@-]*$/i;
const IMAGE_MESSAGE = "Must be a Docker image name, e.g. node:22-bookworm";

// The permission hook refuses chained commands, so a project command is one plain command (§8).
const plainCommand = z
  .string()
  .trim()
  .max(500)
  .refine(
    (c) => !/[&;|<>$`\\\n\r]/.test(c),
    "Must be one plain command: no && ; | < > $ backticks, backslashes or newlines",
  );
// Start is run by the worker, never by an agent (§4), so it may also name the app's port: `--port $PORT`.
const startCommand = z
  .string()
  .trim()
  .max(500)
  .refine(
    (c) => !/[&;|<>$`\\\n\r]/.test(c.replace(/\$PORT\b/g, "")),
    "Must be one plain command: no && ; | < > $ (except $PORT), backticks, backslashes or newlines",
  );

/** Env vars Kanbot sets on project commands itself (§7), so a project can't override them. */
export const RESERVED_ENV = ["PORT", "HOME", "PATH"];

/** Project Settings (§13). An empty command clears it. */
export const patchProjectBody = z
  .object({
    commands: z
      .object({
        install: plainCommand,
        build: plainCommand,
        test: plainCommand,
        lint: plainCommand,
        start: startCommand,
      })
      .partial(),
    // "" clears it.
    image: z
      .string()
      .trim()
      .max(300)
      .refine((s) => !s || IMAGE_REF.test(s), IMAGE_MESSAGE),
    testGlobs: z.array(z.string().trim().min(1).max(300)).max(100),
    hotspots: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(100),
          paths: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
        }),
      )
      .max(50),
    bounceLimit: z.number().int().min(1).max(10),
    concurrency: z.number().int().min(1).max(4),
    // The project's env vars (§10), the whole set: a string sets the value, null keeps the stored one,
    // a name left out is removed. Values are write-only: reads return names only.
    env: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Env var names are letters, digits and _")
          .refine((n) => !RESERVED_ENV.includes(n), `${RESERVED_ENV.join(", ")} are set by Kanbot`),
        z
          .string()
          .max(10_000)
          // shortcut: docker's --env-file is one line per variable; base64 multi-line values (PEM keys) if needed.
          .refine((v) => !/[\n\r]/.test(v), "Env var values can't contain newlines")
          .nullable(),
      )
      .refine((e) => Object.keys(e).length <= 100, "At most 100 env vars"),
  })
  .partial()
  .refine(nonEmpty, "No fields to update");

export const createCriterionBody = z.object({ text: z.string().trim().min(1).max(1_000) });

export const createLinkBody = z.object({
  toKey: z.string().trim().min(1).max(30),
  kind: z.enum(["blocks", "blocked_by", "relates"]),
});
export const patchLinkBody = z.object({ confirmed: z.literal(true) });

export const patchCriterionBody = z
  .object({ text: createCriterionBody.shape.text, status: z.enum(criterionStatuses) })
  .partial()
  .refine(nonEmpty, "No fields to update");

/** Accept some of Plan B's proposed tickets for an epic (UC-11), by their refs. */
export const acceptProposalsBody = z.object({
  refs: z.array(z.string().trim().min(1).max(20)).min(1).max(30),
});

/** The owner's side of onboarding (§10 steps 4–7); the worker does clone and baseline. */
export const onboardingActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm-commands"), settings: patchProjectBody }),
  z.object({
    action: z.enum([
      "retry",
      "rerun-baseline",
      "accept-baseline",
      "open-ci-pr",
      "skip-ci",
      "apply-protection",
      "override-protection",
    ]),
  }),
]);
