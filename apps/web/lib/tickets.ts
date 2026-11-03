import {
  createCommentBody,
  createCriterionBody,
  createTicketBody,
  moveTicketBody,
  patchCriterionBody,
  patchTicketBody,
  type ActivityAction,
} from "@kanbot/shared";
import {
  acceptanceCriteria,
  activity,
  columns,
  comments,
  projects,
  tickets,
} from "@kanbot/shared/db";
import { and, asc, desc, eq, max, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import type { z } from "zod";
import { HttpError, notFound } from "./api";
import { db } from "./db";
import { publish, type Tx } from "./events";

type In<T extends z.ZodType> = z.output<T>;

function logActivity(tx: Tx, ticketId: string, action: ActivityAction, data: object = {}) {
  return tx.insert(activity).values({ ticketId, action, data: data as Record<string, unknown> });
}

async function projectOf(tx: Tx, ticketId: string): Promise<string> {
  const [t] = await tx
    .select({ projectId: tickets.projectId })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!t) throw notFound("Ticket not found");
  return t.projectId;
}

export function createTicket(projectId: string, input: In<typeof createTicketBody>) {
  return db.transaction(async (tx) => {
    // Row lock on the project makes the number allocation atomic.
    const [seq] = await tx
      .update(projects)
      .set({ ticketSeq: sql`${projects.ticketSeq} + 1` })
      .where(eq(projects.id, projectId))
      .returning({ number: projects.ticketSeq });
    if (!seq) throw notFound("Project not found");
    const [backlog] = await tx
      .select({ id: columns.id })
      .from(columns)
      .where(and(eq(columns.projectId, projectId), eq(columns.slug, "backlog")));
    const [last] = await tx
      .select({ position: tickets.position })
      .from(tickets)
      .where(eq(tickets.columnId, backlog!.id))
      .orderBy(desc(sql`${tickets.position} collate "C"`))
      .limit(1);
    const [ticket] = await tx
      .insert(tickets)
      .values({
        ...input,
        projectId,
        number: seq.number,
        columnId: backlog!.id,
        position: generateKeyBetween(last?.position ?? null, null),
      })
      .returning();
    await logActivity(tx, ticket!.id, "created", { title: ticket!.title });
    await publish(tx, projectId, { type: "ticket.created", ticketId: ticket!.id });
    return ticket!;
  });
}

export async function getTicket(id: string) {
  const [row] = await db
    .select({ ticket: tickets, keyPrefix: projects.keyPrefix, columnName: columns.name })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .innerJoin(columns, eq(columns.id, tickets.columnId))
    .where(eq(tickets.id, id));
  if (!row) throw notFound("Ticket not found");
  const criteria = await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.ticketId, id))
    .orderBy(asc(acceptanceCriteria.position));
  return {
    ...row.ticket,
    key: `${row.keyPrefix}-${row.ticket.number}`,
    columnName: row.columnName,
    criteria,
  };
}

export type TicketDetail = Awaited<ReturnType<typeof getTicket>>;

export function patchTicket(id: string, input: In<typeof patchTicketBody>) {
  return db.transaction(async (tx) => {
    const [t] = await tx
      .update(tickets)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(tickets.id, id))
      .returning({ projectId: tickets.projectId });
    if (!t) throw notFound("Ticket not found");
    const fields = Object.keys(input);
    await logActivity(tx, id, "edited", { fields });
    await publish(tx, t.projectId, { type: "ticket.updated", ticketId: id, fields });
  });
}

export function deleteTicket(id: string) {
  return db.transaction(async (tx) => {
    const [t] = await tx
      .delete(tickets)
      .where(eq(tickets.id, id))
      .returning({ projectId: tickets.projectId });
    if (!t) throw notFound("Ticket not found");
    await publish(tx, t.projectId, { type: "ticket.deleted", ticketId: id });
  });
}

/** M1: any column to any column. The transition table and manual-move rules arrive with agents (M2/M3). */
export function moveTicket(id: string, { toColumnId, position }: In<typeof moveTicketBody>) {
  try {
    generateKeyBetween(position, null); // throws on a malformed fractional-index key
  } catch {
    throw new HttpError(400, "invalid_position", "position is not a valid order key");
  }
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select({ projectId: tickets.projectId, columnId: tickets.columnId })
      .from(tickets)
      .where(eq(tickets.id, id))
      .for("update");
    if (!t) throw notFound("Ticket not found");
    const cols = await tx
      .select({ id: columns.id, name: columns.name })
      .from(columns)
      .where(eq(columns.projectId, t.projectId));
    const from = cols.find((c) => c.id === t.columnId)!;
    const to = cols.find((c) => c.id === toColumnId);
    if (!to) throw new HttpError(400, "invalid_column", "Column is not on this ticket's board");

    await tx
      .update(tickets)
      .set({ columnId: to.id, position, updatedAt: new Date() })
      .where(eq(tickets.id, id));
    // Reordering within a column is not worth a timeline entry.
    if (from.id !== to.id) await logActivity(tx, id, "moved", { from: from.name, to: to.name });
    await publish(tx, t.projectId, {
      type: "ticket.moved",
      ticketId: id,
      fromColumnId: from.id,
      toColumnId: to.id,
      position,
      actor: "owner",
    });
  });
}

export function listComments(ticketId: string) {
  return db
    .select()
    .from(comments)
    .where(eq(comments.ticketId, ticketId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

export function addComment(ticketId: string, { bodyMd }: In<typeof createCommentBody>) {
  return db.transaction(async (tx) => {
    const projectId = await projectOf(tx, ticketId);
    const [c] = await tx.insert(comments).values({ ticketId, bodyMd }).returning();
    await logActivity(tx, ticketId, "commented", { commentId: c!.id });
    await publish(tx, projectId, { type: "comment.created", ticketId, commentId: c!.id });
    return c!;
  });
}

export function listActivity(ticketId: string) {
  return db
    .select()
    .from(activity)
    .where(eq(activity.ticketId, ticketId))
    .orderBy(asc(activity.createdAt), asc(activity.id));
}

async function criteriaChanged(tx: Tx, ticketId: string, change: string, text: string) {
  const projectId = await projectOf(tx, ticketId);
  await logActivity(tx, ticketId, "edited", { fields: ["criteria"], change, text });
  await publish(tx, projectId, { type: "ticket.updated", ticketId, fields: ["criteria"] });
}

export function addCriterion(ticketId: string, { text }: In<typeof createCriterionBody>) {
  return db.transaction(async (tx) => {
    await projectOf(tx, ticketId);
    const [{ last } = { last: null }] = await tx
      .select({ last: max(acceptanceCriteria.position) })
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticketId));
    const [c] = await tx
      .insert(acceptanceCriteria)
      .values({ ticketId, text, position: (last ?? -1) + 1 })
      .returning();
    await criteriaChanged(tx, ticketId, "added", text);
    return c!;
  });
}

export function patchCriterion(id: string, input: In<typeof patchCriterionBody>) {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .update(acceptanceCriteria)
      .set(input)
      .where(eq(acceptanceCriteria.id, id))
      .returning();
    if (!c) throw notFound("Criterion not found");
    await criteriaChanged(
      tx,
      c.ticketId,
      input.status ? `marked ${input.status}` : "edited",
      c.text,
    );
    return c;
  });
}

export function deleteCriterion(id: string) {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .delete(acceptanceCriteria)
      .where(eq(acceptanceCriteria.id, id))
      .returning();
    if (!c) throw notFound("Criterion not found");
    await criteriaChanged(tx, c.ticketId, "removed", c.text);
  });
}
