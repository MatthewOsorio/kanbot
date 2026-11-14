import {
  acceptProposalsBody,
  createCommentBody,
  createCriterionBody,
  createTicketBody,
  IN_FLIGHT_COLUMNS,
  moveTicketBody,
  patchCriterionBody,
  patchTicketBody,
  type VerdictPayload,
} from "@kanbot/shared";
import {
  acceptanceCriteria,
  activeRun,
  activity,
  artifacts,
  cancelActiveRun,
  columnEnd,
  columns,
  comments,
  gh,
  git,
  logActivity,
  overlap,
  OWNER,
  projectConfigOf,
  projects,
  type PullRequest,
  removeWorktree,
  repoToken,
  runs,
  screenshots,
  startColumnAgent,
  ticketChanged,
  ticketSpend,
  ticketLinks,
  tickets,
} from "@kanbot/shared/server";
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, max, ne, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import type { z } from "zod";
import { HttpError, notFound } from "./api";
import { linksOf } from "./links";
import { github, requireApp } from "./onboarding";
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
  return db.transaction((tx) => insertTicket(tx, projectId, input));
}

/** A new ticket at the bottom of Backlog, logged and announced. */
async function insertTicket(
  tx: Tx,
  projectId: string,
  input: In<typeof createTicketBody> & { parentId?: string; touchPaths?: string[] },
) {
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
  const position = await columnEnd(tx, backlog!.id);
  const [ticket] = await tx
    .insert(tickets)
    .values({
      ...input,
      projectId,
      number: seq.number,
      columnId: backlog!.id,
      position,
    })
    .returning();
  await logActivity(tx, ticket!.id, "created", { title: ticket!.title });
  await publish(tx, projectId, { type: "ticket.created", ticketId: ticket!.id });
  return ticket!;
}

type Proposal = VerdictPayload["proposedTickets"][number];
type EpicPlanData = { proposedTickets?: Proposal[]; accepted?: Record<string, string> };

/**
 * Creates the accepted proposals of an epic's latest plan (UC-11), or of a spike's latest research (UC-10), in
 * Backlog, as its children, with their criteria, touch sets and confirmed "blocks" links between them. Refs already
 * accepted are refused.
 */
export function acceptProposals(epicId: string, { refs }: In<typeof acceptProposalsBody>) {
  return db.transaction((tx) => acceptProposalsIn(tx, epicId, refs));
}

/** The same inside a transaction. Without `refs` it creates every proposal not yet accepted (approving a spike). */
export async function acceptProposalsIn(tx: Tx, epicId: string, refs?: string[]) {
  {
    const [epic] = await tx.select().from(tickets).where(eq(tickets.id, epicId)).for("update");
    if (!epic) throw notFound("Ticket not found");
    if (epic.type !== "epic" && epic.type !== "spike")
      throw new HttpError(409, "not_epic", "Only an epic or a spike has proposed tickets");
    const [plan] = await tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.ticketId, epicId), inArray(artifacts.kind, ["plan", "research"])))
      .orderBy(desc(artifacts.version))
      .limit(1);
    const data = (plan?.data ?? {}) as EpicPlanData;
    const proposals = data.proposedTickets ?? [];
    if (!plan || !proposals.length) {
      if (refs)
        throw new HttpError(409, "no_proposals", "Its plan or research proposes no tickets");
      return { created: [] };
    }
    const accepted = { ...data.accepted };
    const wanted = new Set(refs ?? proposals.filter((p) => !accepted[p.ref]).map((p) => p.ref));
    for (const ref of wanted) {
      if (!proposals.some((p) => p.ref === ref))
        throw new HttpError(400, "unknown_ref", `The plan proposes no ticket ${ref}`);
      if (accepted[ref]) throw new HttpError(409, "already_accepted", `${ref} is already a ticket`);
    }
    const created = [];
    // Plan order, so a blocker is always created before the tickets it blocks.
    for (const p of proposals.filter((p) => wanted.has(p.ref))) {
      const t = await insertTicket(tx, epic.projectId, {
        title: p.title,
        descriptionMd: p.descriptionMd,
        type: p.type,
        priority: p.priority,
        labels: [],
        parentId: epicId,
        touchPaths: p.touchPaths,
      });
      if (p.acceptanceCriteria.length)
        await tx.insert(acceptanceCriteria).values(
          p.acceptanceCriteria.map((text, i) => ({
            ticketId: t.id,
            position: i,
            text,
            source: "agent" as const,
          })),
        );
      for (const blocker of p.blockedBy.map((r) => accepted[r]).filter(Boolean))
        await tx
          .insert(ticketLinks)
          .values({
            projectId: epic.projectId,
            fromTicketId: blocker!,
            toTicketId: t.id,
            kind: "blocks",
            confirmed: true, // the owner accepted the plan that names it
            source: "agent",
          })
          .onConflictDoNothing();
      accepted[p.ref] = t.id;
      created.push({ ref: p.ref, id: t.id, number: t.number });
    }
    await tx
      .update(artifacts)
      .set({ data: { ...data, accepted } })
      .where(eq(artifacts.id, plan.id));
    await ticketChanged(tx, epic, ["children"], { accepted: [...wanted] });
    return { created };
  }
}

/** A QA screenshot's PNG (§4). */
export async function getScreenshot(id: string) {
  const [row] = await db
    .select({ png: screenshots.png })
    .from(screenshots)
    .where(eq(screenshots.id, id));
  if (!row) throw notFound("Screenshot not found");
  return row.png;
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
  const [criteria, runList, artifactList, links, cost, children, [parent], shots] =
    await Promise.all([
      db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.ticketId, id))
        .orderBy(asc(acceptanceCriteria.position)),
      db.select().from(runs).where(eq(runs.ticketId, id)).orderBy(desc(runs.createdAt)).limit(20),
      // Every version, newest first; the drawer shows the latest and lists the rest (versions are kept).
      // With the agent whose run produced each one (null for an artifact no run made).
      db
        .select({ ...getTableColumns(artifacts), agentSlug: runs.agentSlug })
        .from(artifacts)
        .leftJoin(runs, eq(runs.id, artifacts.runId))
        .where(eq(artifacts.ticketId, id))
        .orderBy(desc(artifacts.createdAt), desc(artifacts.version)),
      linksOf(id),
      // A SQL sum, not the run list above: that one is capped at 20.
      ticketSpend(db, id),
      // An epic's children (UC-11), in creation order.
      db
        .select({
          id: tickets.id,
          number: tickets.number,
          title: tickets.title,
          columnName: columns.name,
          columnSlug: columns.slug,
        })
        .from(tickets)
        .innerJoin(columns, eq(columns.id, tickets.columnId))
        .where(eq(tickets.parentId, id))
        .orderBy(asc(tickets.number)),
      row.ticket.parentId
        ? db
            .select({ id: tickets.id, number: tickets.number, title: tickets.title })
            .from(tickets)
            .where(eq(tickets.id, row.ticket.parentId))
        : [],
      // QA's browser screenshots (§4), shown with their run's test report; the PNG is /api/screenshots/:id.
      db
        .select({ id: screenshots.id, runId: screenshots.runId, name: screenshots.name })
        .from(screenshots)
        .where(eq(screenshots.ticketId, id))
        .orderBy(asc(screenshots.createdAt)),
    ]);
  const key = (n: number) => `${row.keyPrefix}-${n}`;
  return {
    ...row.ticket,
    key: key(row.ticket.number),
    columnName: row.columnName,
    columnSlug: row.columnSlug,
    criteria,
    runs: runList,
    costUsd: cost,
    artifacts: artifactList,
    screenshots: shots,
    links,
    children: children.map((c) => ({ ...c, key: key(c.number) })),
    parent: parent ? { ...parent, key: key(parent.number) } : null,
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
    await ticketChanged(tx, { id, projectId: t.projectId }, Object.keys(input));
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
  // When this fails (an agent still stopping inside it, or the repos mounted read-only in Docker), the
  // worker's nightly cleanup removes it.
  if (t.worktreePath && t.repoPath) await removeWorktree(t.repoPath, t.worktreePath);
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
  // Which agents changed each file, in the order they first did (each run records its own files).
  const fileAgents: Record<string, string[]> = {};
  const runFiles = await db
    .select({ agentSlug: runs.agentSlug, files: runs.filesChanged })
    .from(runs)
    .where(eq(runs.ticketId, id))
    .orderBy(asc(runs.createdAt));
  for (const r of runFiles)
    for (const f of r.files) {
      const list = (fileAgents[f] ??= []);
      if (!list.includes(r.agentSlug)) list.push(r.agentSlug);
    }
  const common = { branch: row.branch, base: row.base, comments: lineComments, fileAgents };
  if (!row.branch || !row.repoPath) return { ...common, diff: "", truncated: false };
  const full = await git(row.repoPath, ["diff", `${row.base}...${row.branch}`]);
  const truncated = full.length > DIFF_CAP;
  return { ...common, diff: truncated ? full.slice(0, DIFF_CAP) : full, truncated };
}
const DIFF_CAP = 1_000_000;

/** Confirmed blockers that aren't Done yet, as keys (§9 "blocked by"). */
async function unfinishedBlockers(tx: Tx, ticketId: string) {
  const rows = await tx
    .select({ number: tickets.number, keyPrefix: projects.keyPrefix })
    .from(ticketLinks)
    .innerJoin(tickets, eq(tickets.id, ticketLinks.fromTicketId))
    .innerJoin(columns, eq(columns.id, tickets.columnId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(
      and(
        eq(ticketLinks.toTicketId, ticketId),
        eq(ticketLinks.kind, "blocks"),
        eq(ticketLinks.confirmed, true),
        ne(columns.slug, "done"),
      ),
    )
    .orderBy(asc(tickets.number));
  return rows.map((r) => `${r.keyPrefix}-${r.number}`);
}

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
  const { hotspots } = await projectConfigOf(tx, p!);
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
 * Into Ship before QA passed asks first (409 `skip_gates`); into PR Review needs a PR (409 `no_pr`);
 * into Done with an open PR asks first (409 `pr_open`), then closes the PR on GitHub (the branch stays).
 */
export async function moveTicket(
  id: string,
  {
    toColumnId,
    position,
    confirmCancel,
    startAnyway,
    keepPlan,
    requestMd,
    confirmSkip,
    confirmClose,
  }: In<typeof moveTicketBody>,
) {
  try {
    generateKeyBetween(position, null); // throws on a malformed fractional-index key
  } catch {
    throw new HttpError(400, "invalid_position", "position is not a valid order key");
  }
  // Before the transaction: GitHub is slow, and a PR that can't be closed stops the move.
  const closed = await closePrForDone(id, toColumnId, !!confirmClose, !!confirmCancel);
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select({
        id: tickets.id,
        projectId: tickets.projectId,
        columnId: tickets.columnId,
        touchPaths: tickets.touchPaths,
        type: tickets.type,
        statusFlag: tickets.statusFlag,
        prNumber: tickets.prNumber,
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

    // An epic is planned and split, never built itself (UC-11).
    if (changesColumn && t.type === "epic" && IN_FLIGHT_COLUMNS.includes(to.slug))
      throw new HttpError(409, "epic", "An epic isn't built itself: accept its proposed tickets");
    if (changesColumn && to.slug === "in_progress" && !startAnyway) {
      const waiting = await unfinishedBlockers(tx, id);
      const hits = await overlapping(tx, t);
      if (waiting.length || hits.length)
        throw new HttpError(
          409,
          "overlap",
          [
            waiting.length && `Waiting on ${waiting.join(", ")}`,
            hits.length && `Overlaps tickets in flight: ${hits.join("; ")}`,
          ]
            .filter(Boolean)
            .join(". "),
        );
    }
    // §3: Ship normally follows QA's pass (or a re-ship from PR Review); anything else skips a gate.
    const passed =
      (from.slug === "qa" && t.statusFlag === "awaiting_approval") || from.slug === "pr_review";
    if (changesColumn && to.slug === "ship" && !passed && !confirmSkip)
      throw new HttpError(409, "skip_gates", "Code Review and QA haven't passed");
    if (changesColumn && to.slug === "pr_review" && !t.prNumber)
      throw new HttpError(409, "no_pr", "This ticket has no pull request yet");
    if (closed) await logActivity(tx, id, "pr_closed", { number: closed });
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
      await startColumnAgent(tx, t.projectId, id, to, OWNER, {
        requestMd: hasPlan ? requestMd : undefined,
      });
  });
}

/** A move into Done with an open PR (§3): 409 `pr_open` until confirmed, then the PR is closed. Returns its number. */
async function closePrForDone(
  id: string,
  toColumnId: string,
  confirmed: boolean,
  confirmCancel: boolean,
) {
  const [row] = await db
    .select({
      prNumber: tickets.prNumber,
      owner: projects.githubOwner,
      repo: projects.githubRepo,
      to: columns.slug,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .innerJoin(columns, eq(columns.id, toColumnId))
    .where(eq(tickets.id, id));
  if (!row || row.to !== "done" || !row.prNumber || !row.owner || !row.repo) return null;
  const pull = `/repos/${row.owner}/${row.repo}/pulls/${row.prNumber}`;
  const token = await github(async () => repoToken(await requireApp(), row.owner!, row.repo!));
  const pr = await github(() => gh<PullRequest>(token, pull));
  if (pr.state !== "open" || pr.merged) return null;
  if (!confirmed) throw new HttpError(409, "pr_open", `Its PR #${row.prNumber} is still open`);
  // Asked before the PR closes: refused after, the move would leave it closed with no pr_closed entry.
  const active = await db.transaction((tx) => activeRun(tx, id));
  if (active && !confirmCancel)
    throw new HttpError(409, "run_active", `${active.agentSlug} is working on this ticket`);
  await github(() => gh(token, pull, { method: "PATCH", body: { state: "closed" } }));
  return row.prNumber;
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

export function addCriterion(ticketId: string, { text }: In<typeof createCriterionBody>) {
  return db.transaction(async (tx) => {
    const projectId = await projectOf(tx, ticketId);
    const [{ last } = { last: null }] = await tx
      .select({ last: max(acceptanceCriteria.position) })
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticketId));
    const [c] = await tx
      .insert(acceptanceCriteria)
      .values({ ticketId, text, position: (last ?? -1) + 1 })
      .returning();
    await ticketChanged(tx, { id: ticketId, projectId }, ["criteria"], { change: "added", text });
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
    await ticketChanged(
      tx,
      { id: c.ticketId, projectId: await projectOf(tx, c.ticketId) },
      ["criteria"],
      { change: input.status ? `marked ${input.status}` : "edited", text: c.text },
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
    await ticketChanged(
      tx,
      { id: c.ticketId, projectId: await projectOf(tx, c.ticketId) },
      ["criteria"],
      { change: "removed", text: c.text },
    );
  });
}
