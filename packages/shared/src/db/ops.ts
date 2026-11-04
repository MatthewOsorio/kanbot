// Ticket/run operations shared by the web app (manual moves, cancel, retry) and the worker (auto-moves).
// Each takes the caller's transaction and writes activity + publishes, per the repo convention.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { agentFileExists } from "../agents";
import { activeRunStates } from "../schemas";
import { runs, tickets } from "./schema";
import { logActivity, OWNER, publish, type Actor, type Tx } from "./write";

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
  requestMd?: string,
) {
  if (!column.agentSlug || !agentFileExists(column.agentSlug)) return null;
  const [r] = await tx
    .insert(runs)
    .values({ ticketId, agentSlug: column.agentSlug, columnSlug: column.slug, requestMd })
    .returning();
  await tx.update(tickets).set({ statusFlag: "running" }).where(eq(tickets.id, ticketId));
  await logActivity(
    tx,
    ticketId,
    "run_started",
    { runId: r!.id, agent: r!.agentSlug, ...(requestMd && { request: requestMd }) },
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

/** Moves a ticket to the bottom of another column (auto-moves and Retry); logs and publishes. */
export async function moveToColumnEnd(
  tx: Tx,
  ticket: { id: string; projectId: string },
  from: Column,
  to: Column,
  actor: Actor,
) {
  const [last] = await tx
    .select({ position: tickets.position })
    .from(tickets)
    .where(eq(tickets.columnId, to.id))
    .orderBy(desc(sql`${tickets.position} collate "C"`))
    .limit(1);
  const position = generateKeyBetween(last?.position ?? null, null);
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
