// Ticket/run operations shared by the web app (manual moves, cancel, retry) and the worker (auto-moves).
// Each takes the caller's transaction and writes activity + publishes, per the repo convention.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { agentFileExists } from "../agents";
import { activeRunStates } from "../schemas";
import { BOUNCE_LIMIT } from "../transitions";
import { QA_SETUP_MESSAGE, qaRunnable } from "../onboarding";
import { loadProjectConfig, projectConfig } from "../repo";
import { projects, runs, settings, tickets } from "./schema";
import { logActivity, OWNER, publish, type Actor, type Tx } from "./write";

/**
 * A project's commands, test globs, hotspots and limits (§9, §11). The first read of a project with a repo
 * seeds the columns from .kanbot/project.yml on the default branch; after that the database is the source.
 */
export async function projectConfigOf(
  tx: Pick<Tx, "select" | "update">,
  p: typeof projects.$inferSelect,
) {
  let c = p.commands
    ? projectConfig.parse({
        commands: p.commands,
        testGlobs: p.testGlobs ?? [],
        hotspots: p.hotspots ?? [],
        image: p.image ?? undefined,
        dockerfile: p.dockerfile ?? undefined,
      })
    : projectConfig.parse({});
  if (!p.commands && p.repoPath) {
    c = await loadProjectConfig(p.repoPath, p.defaultBranch);
    // "commands is null" in the WHERE: a racing second seeder changes nothing, and we re-read the winner.
    const done = await tx
      .update(projects)
      .set({
        commands: c.commands,
        testGlobs: c.testGlobs,
        hotspots: c.hotspots,
        image: c.image ?? null,
        dockerfile: c.dockerfile ?? null,
      })
      .where(and(eq(projects.id, p.id), sql`${projects.commands} is null`))
      .returning({ id: projects.id });
    if (!done.length) {
      const [q] = await tx.select().from(projects).where(eq(projects.id, p.id));
      return projectConfigOf(tx, q!);
    }
  }
  return {
    ...c,
    bounceLimit: p.settings?.bounceLimit ?? BOUNCE_LIMIT,
    concurrency: p.settings?.concurrency ?? 1,
  };
}

/** Thrown by startColumnAgent while a GitHub project is still onboarding (the web app answers 409). */
export class AgentsDisabledError extends Error {
  constructor() {
    super(
      "Finish this project's setup first: agents start once branch protection is in place or overridden",
    );
  }
}

/** Thrown by startColumnAgent for QA on a project with no start command (§4; the web app answers 409). */
export class QaSetupError extends Error {
  constructor() {
    super(QA_SETUP_MESSAGE);
  }
}

/** Whether QA can run on this project: always, for a project with no repo (tests); else qaRunnable. */
export async function qaReady(tx: Pick<Tx, "select" | "update">, projectId: string) {
  const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
  return !p?.repoPath || qaRunnable(await projectConfigOf(tx, p));
}

type Column = { id: string; slug: string; name: string; agentSlug: string | null };

/** The ticket's active run, if any (at most one: partial unique index on runs). */
export async function activeRun(tx: Tx, ticketId: string) {
  const [r] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.ticketId, ticketId), inArray(runs.state, [...activeRunStates])));
  return r ?? null;
}

/** Cancels the ticket's active run, if any. The worker hears run.finished and aborts it. */
export async function cancelActiveRun(tx: Tx, projectId: string, ticketId: string, actor = OWNER) {
  const [r] = await tx
    .update(runs)
    .set({ state: "cancelled", endedAt: new Date() })
    .where(and(eq(runs.ticketId, ticketId), inArray(runs.state, [...activeRunStates])))
    .returning();
  if (!r) return null;
  await tx.update(tickets).set({ statusFlag: "none" }).where(eq(tickets.id, ticketId));
  await logActivity(
    tx,
    ticketId,
    "run_finished",
    { runId: r.id, agent: r.agentSlug, state: "cancelled" },
    actor,
  );
  await publish(tx, projectId, {
    type: "run.finished",
    runId: r.id,
    ticketId,
    agentSlug: r.agentSlug,
    state: "cancelled",
  });
  return r;
}

/**
 * Queues the column's agent for the ticket (requirements §8 run lifecycle step 1).
 * Returns null when the column has no agent, or its agent file hasn't shipped yet: then it's a gate.
 * The caller must have cancelled any active run first (the partial unique index enforces it).
 */
export async function startColumnAgent(
  tx: Tx,
  projectId: string,
  ticketId: string,
  column: Column,
  actor: Actor = OWNER,
  /** requestMd: the owner's words the run answers; resumeSessionId: the agent session it continues. */
  { requestMd, resumeSessionId }: { requestMd?: string; resumeSessionId?: string | null } = {},
) {
  if (!column.agentSlug || !agentFileExists(column.agentSlug)) return null;
  // §10 step 10: a GitHub project runs agents once branch protection is applied or overridden.
  const [p] = await tx
    .select({ repo: projects.githubRepo, onboarding: projects.onboarding })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (p?.repo && p.onboarding?.step !== "ready") throw new AgentsDisabledError();
  // Ship pushes to GitHub (FR-43): a local-folder project's Ship stays a gate.
  if (column.slug === "ship" && !p?.repo) return null;
  if (column.slug === "qa" && !(await qaReady(tx, projectId))) throw new QaSetupError();
  const [r] = await tx
    .insert(runs)
    .values({
      ticketId,
      agentSlug: column.agentSlug,
      columnSlug: column.slug,
      requestMd,
      resumeSessionId,
    })
    .returning();
  await tx.update(tickets).set({ statusFlag: "running" }).where(eq(tickets.id, ticketId));
  await logActivity(
    tx,
    ticketId,
    "run_started",
    {
      runId: r!.id,
      agent: r!.agentSlug,
      ...(requestMd && { request: requestMd }),
      ...(resumeSessionId !== undefined && { resumed: true }), // null: Resume, but no session to continue
    },
    actor,
  );
  await publish(tx, projectId, {
    type: "run.started",
    runId: r!.id,
    ticketId,
    agentSlug: r!.agentSlug,
    state: "queued",
  });
  return r!;
}

export type Settings = typeof settings.$inferSelect;

export async function getSettings(tx: Pick<Tx, "select">): Promise<Settings> {
  const [s] = await tx.select().from(settings);
  return (
    s ?? {
      id: 1,
      paused: false,
      pausedReason: null,
      dailyBudgetUsd: 5,
      githubApp: null,
      updatedAt: new Date(),
    }
  );
}

/** Updates the settings row (creating it on first use) and tells the web app and worker. */
export async function updateSettings(
  tx: Tx,
  patch: Partial<Pick<Settings, "paused" | "pausedReason" | "dailyBudgetUsd">>,
) {
  const values = { ...patch, updatedAt: new Date() };
  const [s] = await tx
    .insert(settings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values })
    .returning();
  await publish(tx, "*", { type: "settings.updated", paused: s!.paused });
  return s!;
}

/**
 * Today's spend for the daily cap (requirements §14): the cost of runs that ended since local midnight,
 * plus `reserved`, the budgets of runs still going (their cost is only known when they end).
 */
export async function spendToday(tx: Pick<Tx, "select">) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const [r] = await tx
    .select({
      spent: sql<number>`coalesce(sum(${runs.costUsd}) filter (where ${runs.endedAt} >= ${midnight}), 0)::float8`,
      reserved: sql<number>`coalesce(sum(${runs.budgetUsd}) filter (where ${runs.state} = 'running'), 0)::float8`,
    })
    .from(runs);
  return r!;
}

/** The position key for a new last card in a column. */
export async function columnEnd(tx: Pick<Tx, "select">, columnId: string) {
  const [last] = await tx
    .select({ position: tickets.position })
    .from(tickets)
    .where(eq(tickets.columnId, columnId))
    .orderBy(desc(sql`${tickets.position} collate "C"`))
    .limit(1);
  return generateKeyBetween(last?.position ?? null, null);
}

/** Moves a ticket to the bottom of another column (auto-moves and Retry); logs and publishes. */
export async function moveToColumnEnd(
  tx: Tx,
  ticket: { id: string; projectId: string },
  from: Column,
  to: Column,
  actor: Actor,
) {
  const position = await columnEnd(tx, to.id);
  await tx
    .update(tickets)
    .set({ columnId: to.id, position, updatedAt: new Date() })
    .where(eq(tickets.id, ticket.id));
  await logActivity(tx, ticket.id, "moved", { from: from.name, to: to.name }, actor);
  await publish(tx, ticket.projectId, {
    type: "ticket.moved",
    ticketId: ticket.id,
    fromColumnId: from.id,
    toColumnId: to.id,
    position,
    actor: actor.name,
  });
}
