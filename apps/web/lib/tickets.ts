import {
  createCommentBody,
  createCriterionBody,
  createTicketBody,
  IN_FLIGHT_COLUMNS,
  moveTicketBody,
  patchCriterionBody,
  patchTicketBody,
} from "@kanbot/shared";
import {
  acceptanceCriteria,
  activeRun,
  activity,
  artifacts,
  cancelActiveRun,
  columns,
  comments,
  logActivity,
  OWNER,
  projects,
  runs,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/db";
import { git, loadProjectConfig, overlap } from "@kanbot/shared/repo";
import { and, asc, desc, eq, inArray, isNotNull, max, ne, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import type { z } from "zod";
import { HttpError, notFound } from "./api";
import { planExists } from "./runs";
import { db } from "./db";
import { publish, type Tx } from "./events";

type In<T extends z.ZodType> = z.output<T>;

/** `lock`: take the ticket row lock before touching its runs, the order the worker's finish() uses. */
async function projectOf(tx: Tx, ticketId: string, lock = false): Promise<string> {
  const q = tx
    .select({ projectId: tickets.projectId })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  const [t] = await (lock ? q.for("update") : q);
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
    .select({
      ticket: tickets,
      keyPrefix: projects.keyPrefix,
      columnName: columns.name,
      columnSlug: columns.slug,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .innerJoin(columns, eq(columns.id, tickets.columnId))
    .where(eq(tickets.id, id));
  if (!row) throw notFound("Ticket not found");
  const [criteria, runList, artifactList] = await Promise.all([
    db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, id))
      .orderBy(asc(acceptanceCriteria.position)),
    db.select().from(runs).where(eq(runs.ticketId, id)).orderBy(desc(runs.createdAt)).limit(20),
    // Every version, newest first; the drawer shows the latest and lists the rest (versions are kept).
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.ticketId, id))
      .orderBy(desc(artifacts.createdAt), desc(artifacts.version)),
  ]);
  return {
    ...row.ticket,
    key: `${row.keyPrefix}-${row.ticket.number}`,
    columnName: row.columnName,
    columnSlug: row.columnSlug,
    criteria,
    runs: runList,
    artifacts: artifactList,
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

export async function deleteTicket(id: string) {
  const t = await db.transaction(async (tx) => {
    const projectId = await projectOf(tx, id, true);
    await cancelActiveRun(tx, projectId, id); // tells the worker to stop the agent before the run row goes
    const [t] = await tx
      .delete(tickets)
      .where(eq(tickets.id, id))
      .returning({ projectId: tickets.projectId, worktreePath: tickets.worktreePath });
    if (!t) throw notFound("Ticket not found");
    await publish(tx, t.projectId, { type: "ticket.deleted", ticketId: id });
    const [p] = await tx.select().from(projects).where(eq(projects.id, t.projectId));
    return { ...t, repoPath: p!.repoPath };
  });
  // FR-49: the worktree goes with the ticket; the branch stays (it may hold work worth keeping).
  // shortcut: a cancelled agent may still be stopping inside it; the removal then fails and the folder stays until the M5 nightly cleanup.
  if (t.worktreePath && t.repoPath)
    await git(t.repoPath, ["worktree", "remove", "--force", t.worktreePath]).catch((e: Error) =>
      console.warn(`Could not remove worktree ${t.worktreePath}: ${e.message}`),
    );
}

/** The branch diff vs the default branch (FR-41), with the review's line comments for the Diff tab. */
export async function getDiff(id: string) {
  const [row] = await db
    .select({
      branch: tickets.branchName,
      repoPath: projects.repoPath,
      base: projects.defaultBranch,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, id));
  if (!row) throw notFound("Ticket not found");
  const lineComments = await db
    .select()
    .from(comments)
    .where(and(eq(comments.ticketId, id), isNotNull(comments.file)))
    .orderBy(asc(comments.createdAt));
  if (!row.branch || !row.repoPath)
    return {
      branch: row.branch,
      base: row.base,
      diff: "",
      truncated: false,
      comments: lineComments,
    };
  const full = await git(row.repoPath, ["diff", `${row.base}...${row.branch}`]);
  const truncated = full.length > DIFF_CAP;
  return {
    branch: row.branch,
    base: row.base,
    diff: truncated ? full.slice(0, DIFF_CAP) : full,
    truncated,
    comments: lineComments,
  };
}
const DIFF_CAP = 1_000_000;

/**
 * The §9 overlap check before In Progress: tickets in flight whose touch set or hotspot groups overlap
 * this one's. Advisory: the owner can start anyway. A ticket with no touch set yet overlaps nothing.
 */
async function overlapping(
  tx: Tx,
  ticket: { id: string; projectId: string; touchPaths: string[] },
) {
  if (!ticket.touchPaths.length) return [];
  const [p] = await tx.select().from(projects).where(eq(projects.id, ticket.projectId));
  const { hotspots } = p!.repoPath
    ? await loadProjectConfig(p!.repoPath, p!.defaultBranch)
    : { hotspots: [] };
  const others = await tx
    .select({ number: tickets.number, touchPaths: tickets.touchPaths })
    .from(tickets)
    .innerJoin(columns, eq(columns.id, tickets.columnId))
    .where(
      and(
        eq(tickets.projectId, ticket.projectId),
        ne(tickets.id, ticket.id),
        inArray(columns.slug, IN_FLIGHT_COLUMNS),
      ),
    );
  return others.flatMap((o) => {
    const { files, hotspots: groups } = overlap(ticket.touchPaths, o.touchPaths, hotspots);
    const what = [
      ...(files.length ? [`${files.length} file${files.length > 1 ? "s" : ""}`] : []),
      ...groups.map((g) => `hotspot ${g}`),
    ];
    return what.length ? [`${p!.keyPrefix}-${o.number} (${what.join(", ")})`] : [];
  });
}

/**
 * Manual move (requirements §3 "Manual moves"): any column to any column. Moving to another column
 * cancels the active run (only with confirmCancel, FR-24), clears the status flag (dropping on Ready
 * is the plan approval) and starts the target column's agent. Reordering within a column changes nothing else.
 * Entering In Progress runs the overlap check (409 `overlap` unless startAnyway); entering Planning
 * resets the bounce count. Entering Planning with a plan already there asks first (409 `has_plan`):
 * keepPlan keeps it (Plan ready, no run), requestMd has Plan B revise it.
 * Ship/Done confirmations arrive with Ship-It (M5).
 */
export function moveTicket(
  id: string,
  {
    toColumnId,
    position,
    confirmCancel,
    startAnyway,
    keepPlan,
    requestMd,
  }: In<typeof moveTicketBody>,
) {
  try {
    generateKeyBetween(position, null); // throws on a malformed fractional-index key
  } catch {
    throw new HttpError(400, "invalid_position", "position is not a valid order key");
  }
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select({
        id: tickets.id,
        projectId: tickets.projectId,
        columnId: tickets.columnId,
        touchPaths: tickets.touchPaths,
      })
      .from(tickets)
      .where(eq(tickets.id, id))
      .for("update");
    if (!t) throw notFound("Ticket not found");
    const cols = await tx.select().from(columns).where(eq(columns.projectId, t.projectId));
    const from = cols.find((c) => c.id === t.columnId)!;
    const to = cols.find((c) => c.id === toColumnId);
    if (!to) throw new HttpError(400, "invalid_column", "Column is not on this ticket's board");
    const changesColumn = from.id !== to.id;

    if (changesColumn && to.slug === "in_progress" && !startAnyway) {
      const hits = await overlapping(tx, t);
      if (hits.length)
        throw new HttpError(409, "overlap", `Overlaps tickets in flight: ${hits.join("; ")}`);
    }
    const hasPlan = changesColumn && to.slug === "planning" && (await planExists(tx, id));
    if (hasPlan && !keepPlan && !requestMd)
      throw new HttpError(409, "has_plan", "This ticket already has a plan");
    const keep = hasPlan && !requestMd; // back to Planning without re-planning
    if (changesColumn) {
      const active = await activeRun(tx, id);
      if (active && !confirmCancel)
        throw new HttpError(409, "run_active", `${active.agentSlug} is working on this ticket`);
      await cancelActiveRun(tx, t.projectId, id);
    }
    await tx
      .update(tickets)
      .set({
        columnId: to.id,
        position,
        updatedAt: new Date(),
        ...(changesColumn && { statusFlag: keep ? ("plan_ready" as const) : ("none" as const) }),
        // Re-planning starts the build loop over (§3 Manual moves, FR-23).
        ...(changesColumn && to.slug === "planning" && { bounceCount: 0 }),
      })
      .where(eq(tickets.id, id));
    // Reordering within a column is not worth a timeline entry.
    if (changesColumn) await logActivity(tx, id, "moved", { from: from.name, to: to.name });
    await publish(tx, t.projectId, {
      type: "ticket.moved",
      ticketId: id,
      fromColumnId: from.id,
      toColumnId: to.id,
      position,
      actor: "owner",
    });
    if (changesColumn && !keep)
      await startColumnAgent(tx, t.projectId, id, to, OWNER, hasPlan ? requestMd : undefined);
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
