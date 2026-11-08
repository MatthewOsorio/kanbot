// Subset of requirements §11 (M1–M3). Later milestones add their tables/columns in their own migrations
// (see "Still to build" in docs/requirements.md §16).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "../ids";
import type { Baseline, Onboarding } from "../onboarding";
import type { ProjectConfig } from "../repo";
import {
  activityActions,
  artifactKinds,
  authorKinds,
  criterionSources,
  criterionStatuses,
  linkKinds,
  linkSources,
  priorities,
  runEventTypes,
  runStates,
  statusFlags,
  ticketTypes,
} from "../schemas";

const id = () => uuid("id").primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const ticketType = pgEnum("ticket_type", ticketTypes);
export const ticketPriority = pgEnum("ticket_priority", priorities);
export const criterionStatus = pgEnum("criterion_status", criterionStatuses);
export const activityAction = pgEnum("activity_action", activityActions);
export const criterionSource = pgEnum("criterion_source", criterionSources);
export const statusFlag = pgEnum("ticket_status_flag", statusFlags);
export const runState = pgEnum("run_state", runStates);
export const runEventType = pgEnum("run_event_type", runEventTypes);
export const artifactKind = pgEnum("artifact_kind", artifactKinds);
export const linkKind = pgEnum("link_kind", linkKinds);
export const linkSource = pgEnum("link_source", linkSources);
export const authorKind = pgEnum("author_kind", authorKinds);

export const projects = pgTable("projects", {
  id: id(),
  keyPrefix: text("key_prefix").notNull().unique(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  repoPath: text("repo_path"),
  // The GitHub repo (§10 onboarding); null for a local-folder project.
  githubOwner: text("github_owner"),
  githubRepo: text("github_repo"),
  onboarding: jsonb("onboarding").$type<Onboarding>(),
  baseline: jsonb("baseline").$type<Baseline>(),
  // Project settings (§11). null = not seeded yet; projectConfigOf seeds them once from .kanbot/project.yml.
  commands: jsonb("commands").$type<ProjectConfig["commands"]>(),
  testGlobs: text("test_globs").array(),
  hotspots: jsonb("hotspots").$type<ProjectConfig["hotspots"]>(),
  image: text("image"),
  dockerfile: jsonb("dockerfile").$type<ProjectConfig["dockerfile"]>(),
  // The project's env vars (§10), encrypted JSON {NAME: value} (github.ts encryptEnv); "" = not set yet.
  env: text("env"),
  settings: jsonb("settings").$type<{ bounceLimit?: number; concurrency?: number }>(),
  ticketSeq: integer("ticket_seq").notNull().default(0),
  createdAt: createdAt(),
});

export const columns = pgTable(
  "columns",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    agentSlug: text("agent_slug"),
  },
  (t) => [unique().on(t.projectId, t.slug)],
);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    descriptionMd: text("description_md").notNull().default(""),
    type: ticketType("type").notNull().default("feature"),
    priority: ticketPriority("priority").notNull().default("P2"),
    labels: text("labels").array().notNull().default([]),
    columnId: uuid("column_id")
      .notNull()
      .references(() => columns.id),
    // fractional-indexing key; always ORDER BY it with COLLATE "C" (byte order), never the default collation
    position: text("position").notNull(),
    statusFlag: statusFlag("status_flag").notNull().default("none"),
    // Set when the worker first creates the ticket's worktree (FR-40); the branch outlives the worktree.
    branchName: text("branch_name"),
    worktreePath: text("worktree_path"),
    // The PR the worker opened after Captain Ship-It's run (FR-43); headSha is the head it pushed.
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    headSha: text("head_sha"),
    // Code Review and QA bounce-backs (FR-23); reset by a manual move to Planning.
    bounceCount: integer("bounce_count").notNull().default(0),
    // Plan B's predicted paths/globs plus the files the branch actually changed (§9).
    touchPaths: text("touch_paths").array().notNull().default([]),
    // The epic this ticket was split from (UC-11); deleting the epic keeps its children.
    parentId: uuid("parent_id").references((): AnyPgColumn => tickets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.projectId, t.number), index().on(t.columnId), index().on(t.parentId)],
);

export const acceptanceCriteria = pgTable(
  "acceptance_criteria",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    status: criterionStatus("status").notNull().default("open"),
    source: criterionSource("source").notNull().default("user"),
  },
  (t) => [index().on(t.ticketId)],
);

/** `from` blocks `to`; for `relates` the direction is arbitrary. Agent-proposed links stay unconfirmed until the owner confirms. */
export const ticketLinks = pgTable(
  "ticket_links",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromTicketId: uuid("from_ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    toTicketId: uuid("to_ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    kind: linkKind("kind").notNull(),
    confirmed: boolean("confirmed").notNull().default(false),
    source: linkSource("source").notNull().default("user"),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.fromTicketId, t.toTicketId, t.kind), index().on(t.toTicketId)],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    bodyMd: text("body_md").notNull(),
    authorKind: authorKind("author_kind").notNull().default("user"),
    agentSlug: text("agent_slug"),
    // Review line comments (Nancy); null for general comments.
    file: text("file"),
    line: integer("line"),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ticketId)],
);

export const activity = pgTable(
  "activity",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    actorKind: text("actor_kind").notNull().default("user"),
    actor: text("actor").notNull().default("owner"),
    action: activityAction("action").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ticketId)],
);

export const runs = pgTable(
  "runs",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    agentSlug: text("agent_slug").notNull(),
    columnSlug: text("column_slug").notNull(),
    state: runState("state").notNull().default("queued"),
    verdict: text("verdict"),
    summary: text("summary"),
    // The owner's "Request changes" text this run answers (UC-3); null for runs started by a move.
    requestMd: text("request_md"),
    sessionId: text("session_id"),
    // The agent session this run continues (Resume, or a bounce back to the same agent; FR-35).
    resumeSessionId: text("resume_session_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4, mode: "number" }).notNull().default(0),
    // What this run may spend, set when it is claimed: the agent's budget, capped by what's left of the day.
    budgetUsd: numeric("budget_usd", { precision: 10, scale: 4, mode: "number" }),
    error: text("error"),
    // Files this run changed in the worktree (committed or not), for "who changed what" in the Diff tab.
    filesChanged: text("files_changed").array().notNull().default([]),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    // One active run per ticket (requirements §11); keep in sync with activeRunStates.
    uniqueIndex("runs_one_active_per_ticket")
      .on(t.ticketId)
      .where(sql`${t.state} in ('queued', 'running')`),
    index().on(t.state, t.createdAt),
    index().on(t.ticketId, t.createdAt),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: runEventType("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.runId, t.seq)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    kind: artifactKind("kind").notNull(),
    title: text("title").notNull(),
    version: integer("version").notNull(),
    contentMd: text("content_md").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.ticketId, t.kind, t.version)],
);

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/** QA's browser screenshots (§4), shown with the run's test report in the drawer. */
export const screenshots = pgTable(
  "screenshots",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    png: bytea("png").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ticketId)],
);

/** Global settings (requirements §11): one row, id 1; a missing row means the defaults. */
export const settings = pgTable(
  "settings",
  {
    id: integer("id").primaryKey().default(1),
    paused: boolean("paused").notNull().default(false),
    // Set when Kanbot paused itself (auth or billing error); null when the owner paused.
    pausedReason: text("paused_reason"),
    dailyBudgetUsd: numeric("daily_budget_usd", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(5),
    // The GitHub App (§10), encrypted JSON (github.ts); null until the two-click setup.
    githubApp: text("github_app"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
);
