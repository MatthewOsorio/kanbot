import { activeRunStates } from "@kanbot/shared";
import {
  activeRun,
  artifacts,
  cancelActiveRun,
  columns,
  moveToColumnEnd,
  OWNER,
  runEvents,
  runs,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/db";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { HttpError, notFound } from "./api";
import { db } from "./db";
import type { Tx } from "./events";

export function listRuns(ticketId: string) {
  return db.select().from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.createdAt));
}

/** Paged run log; the Live tab fetches what it hasn't seen after every run.event (requirements §12). */
export async function listRunEvents(runId: string, after: number) {
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
  if (!run) throw notFound("Run not found");
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
    .orderBy(asc(runEvents.seq))
    .limit(500);
}

async function runWithTicket(tx: Tx, runId: string) {
  const [row] = await tx
    .select({ run: runs, ticket: tickets })
    .from(runs)
    .innerJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(eq(runs.id, runId))
    .for("update", { of: tickets });
  if (!row) throw notFound("Run not found");
  return row;
}

export function cancelRun(runId: string) {
  return db.transaction(async (tx) => {
    const { run, ticket } = await runWithTicket(tx, runId);
    if (!(activeRunStates as readonly string[]).includes(run.state))
      throw new HttpError(409, "run_finished", `Run is already ${run.state}`);
    await cancelActiveRun(tx, ticket.projectId, ticket.id);
  });
}

/**
 * "Request changes" on a plan (UC-3): Plan B re-runs at once with the owner's request, no drag needed.
 * Comments stay general; only this request tells Plan B what to change.
 */
export function revisePlan(ticketId: string, requestMd: string) {
  return db.transaction(async (tx) => {
    const { ticket, column } = await plannedTicket(tx, ticketId, "revised");
    const next = await startColumnAgent(tx, ticket.projectId, ticketId, column, OWNER, requestMd);
    if (!next) throw new HttpError(409, "no_agent", "Planning has no agent file");
    return next;
  });
}

/** "Approve plan" in the drawer: the same as dropping the ticket at the bottom of Ready. */
export function approvePlan(ticketId: string) {
  return db.transaction(async (tx) => {
    const { ticket, column } = await plannedTicket(tx, ticketId, "approved");
    const [ready] = await tx
      .select()
      .from(columns)
      .where(and(eq(columns.projectId, ticket.projectId), eq(columns.slug, "ready")));
    if (!ready) throw new HttpError(409, "column_gone", "This board has no Ready column");
    await tx.update(tickets).set({ statusFlag: "none" }).where(eq(tickets.id, ticketId));
    await moveToColumnEnd(tx, ticket, column, ready, OWNER);
  });
}

/** Locks a ticket that is in Planning with a plan and no active run, or throws 409. */
async function plannedTicket(tx: Tx, ticketId: string, verb: string) {
  const [row] = await tx
    .select({ ticket: tickets, column: columns })
    .from(tickets)
    .innerJoin(columns, eq(columns.id, tickets.columnId))
    .where(eq(tickets.id, ticketId))
    .for("update", { of: tickets });
  if (!row) throw notFound("Ticket not found");
  if (row.column.slug !== "planning")
    throw new HttpError(409, "not_in_planning", `Plans can only be ${verb} in Planning`);
  const [plan] = await tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.ticketId, ticketId), eq(artifacts.kind, "plan")))
    .limit(1);
  if (!plan) throw new HttpError(409, "no_plan", `This ticket has no plan to be ${verb} yet`);
  if (await activeRun(tx, ticketId))
    throw new HttpError(409, "run_active", "This ticket already has an active run");
  return row;
}

/**
 * Starts a fresh run of the same agent (FR-35). A failed run usually left the ticket in Blocked, so
 * the ticket goes back to the run's column first, as if the owner had dragged it there.
 */
export function retryRun(runId: string) {
  return db.transaction(async (tx) => {
    const { run, ticket } = await runWithTicket(tx, runId);
    if (await activeRun(tx, ticket.id))
      throw new HttpError(409, "run_active", "This ticket already has an active run");
    const cols = await tx.select().from(columns).where(eq(columns.projectId, ticket.projectId));
    const from = cols.find((c) => c.id === ticket.columnId)!;
    const to = cols.find((c) => c.slug === run.columnSlug);
    if (!to) throw new HttpError(409, "column_gone", `Column ${run.columnSlug} no longer exists`);
    if (to.id !== from.id) await moveToColumnEnd(tx, ticket, from, to, OWNER);
    const next = await startColumnAgent(tx, ticket.projectId, ticket.id, to);
    if (!next) throw new HttpError(409, "no_agent", `${run.agentSlug} has no agent file`);
    return next;
  });
}
