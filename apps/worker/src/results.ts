// What a finished run leaves behind: its artifacts, comments, criteria and links (§8 step 5).
import { type VerdictPayload } from "@kanbot/shared";
import {
  acceptanceCriteria,
  artifacts,
  comments,
  logActivity,
  projects,
  publish,
  runs,
  ticketChanged,
  ticketLinks,
  tickets,
  type Tx,
  agentActor,
} from "@kanbot/shared/db";
import { and, eq, max } from "drizzle-orm";

export type Run = typeof runs.$inferSelect;

export type TicketRef = { id: string; projectId: string };

/** Adds an agent comment, logs it and announces it. */
export async function agentComment(
  tx: Tx,
  ticket: TicketRef,
  slug: string,
  c: { bodyMd: string; file?: string; line?: number },
) {
  const [row] = await tx
    .insert(comments)
    .values({ ticketId: ticket.id, authorKind: "agent", agentSlug: slug, ...c })
    .returning({ id: comments.id });
  await logActivity(tx, ticket.id, "commented", { commentId: row!.id }, agentActor(slug));
  await publish(tx, ticket.projectId, {
    type: "comment.created",
    ticketId: ticket.id,
    commentId: row!.id,
  });
}

/** A new artifact version (never overwriting) and its event; run is null for the GitHub watcher's. */
export async function storeArtifact(
  tx: Tx,
  ticket: TicketRef,
  run: Pick<Run, "id"> | null,
  a: VerdictPayload["artifacts"][number],
  data: Record<string, unknown> = {},
) {
  const [{ last } = { last: null }] = await tx
    .select({ last: max(artifacts.version) })
    .from(artifacts)
    .where(and(eq(artifacts.ticketId, ticket.id), eq(artifacts.kind, a.kind)));
  const [row] = await tx
    .insert(artifacts)
    .values({
      ticketId: ticket.id,
      runId: run?.id ?? null,
      kind: a.kind,
      title: a.title,
      version: (last ?? 0) + 1,
      contentMd: a.markdown,
      data,
    })
    .returning({ id: artifacts.id });
  await publish(tx, ticket.projectId, {
    type: "artifact.created",
    ticketId: ticket.id,
    artifactId: row!.id,
  });
}

/** Plan B's proposals, cleaned: duplicate refs dropped, `blockedBy` kept only for earlier refs (no cycles). */
export function proposedTickets(list: VerdictPayload["proposedTickets"]) {
  const seen = new Set<string>();
  return list.flatMap((p) => {
    if (seen.has(p.ref)) return [];
    const blockedBy = [...new Set(p.blockedBy)].filter((r) => seen.has(r));
    seen.add(p.ref);
    return [{ ...p, blockedBy }];
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stores what the verdict carries: artifacts (new versions, never overwriting), Plan B's criteria and
 * touch set, Nancy's line comments and cross-ticket risks, Testy's per-criterion results.
 */
export async function storeResults(tx: Tx, ticket: TicketRef, run: Run, v: VerdictPayload) {
  const actor = agentActor(run.agentSlug);
  // An epic's plan carries its proposed tickets, for the owner to accept (UC-11).
  const split = v.verdict === "success" ? proposedTickets(v.proposedTickets) : [];
  for (const a of v.artifacts)
    await storeArtifact(
      tx,
      ticket,
      run,
      a,
      a.kind === "plan" && split.length ? { proposedTickets: split, accepted: {} } : {},
    );

  if (v.verdict === "success" && v.touchPaths)
    await tx.update(tickets).set({ touchPaths: v.touchPaths }).where(eq(tickets.id, ticket.id));

  if (v.verdict === "success" && v.acceptanceCriteria) {
    // A new plan's checklist replaces the previous agent-written one; the owner's items stay.
    await tx
      .delete(acceptanceCriteria)
      .where(
        and(eq(acceptanceCriteria.ticketId, ticket.id), eq(acceptanceCriteria.source, "agent")),
      );
    const [{ last } = { last: null }] = await tx
      .select({ last: max(acceptanceCriteria.position) })
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticket.id));
    if (v.acceptanceCriteria.length)
      await tx.insert(acceptanceCriteria).values(
        v.acceptanceCriteria.map((text, i) => ({
          ticketId: ticket.id,
          text,
          source: "agent" as const,
          position: (last ?? -1) + 1 + i,
        })),
      );
    await ticketChanged(
      tx,
      ticket,
      ["criteria"],
      { change: "replaced by plan", count: v.acceptanceCriteria.length },
      actor,
    );
  }

  // Each review supersedes the reviewer's earlier comments, so "unresolved" means the latest review.
  if (run.columnSlug === "code_review")
    await tx
      .update(comments)
      .set({ resolved: true })
      .where(
        and(
          eq(comments.ticketId, ticket.id),
          eq(comments.agentSlug, run.agentSlug),
          eq(comments.resolved, false),
        ),
      );
  for (const c of v.comments)
    await agentComment(tx, ticket, run.agentSlug, { bodyMd: c.body, file: c.file, line: c.line });

  const proposals: { other: TicketRef; kind: "blocks" | "blocked_by" | "relates" }[] = [];
  if (v.crossTicketRisks.length || v.relatedTickets.length) {
    const [me] = await tx
      .select({ number: tickets.number, keyPrefix: projects.keyPrefix })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticket.id));
    const myKey = `${me!.keyPrefix}-${me!.number}`;
    // A key from another project, or this ticket itself, resolves to nothing.
    const find = async (key: string) => {
      const n = key.startsWith(`${me!.keyPrefix}-`) ? Number(key.split("-").pop()) : NaN;
      const [other] = Number.isInteger(n)
        ? await tx
            .select({ id: tickets.id, projectId: tickets.projectId })
            .from(tickets)
            .where(and(eq(tickets.projectId, ticket.projectId), eq(tickets.number, n)))
        : [];
      return other && other.id !== ticket.id ? other : undefined;
    };
    for (const r of v.crossTicketRisks) {
      const note = `**Cross-ticket risk (${r.severity}, ${r.kind})**: ${r.description}`;
      await agentComment(tx, ticket, run.agentSlug, { bodyMd: `${r.ticket}: ${note}` });
      // The note goes on the other ticket too (§9).
      const other = await find(r.ticket);
      if (!other) continue;
      await agentComment(tx, other, run.agentSlug, { bodyMd: `${myKey}: ${note}` });
      // Merging both would break: propose that the other ticket goes first, for the owner to confirm.
      if (r.severity === "blocking") proposals.push({ other, kind: "blocked_by" });
    }
    for (const r of v.relatedTickets) {
      const other = await find(r.ticket);
      if (other) proposals.push({ other, kind: r.kind });
    }
  }
  for (const { other, kind } of proposals) {
    const [row] = await tx
      .insert(ticketLinks)
      .values({
        projectId: ticket.projectId,
        // "blocks" runs from the blocker to the blocked ticket.
        fromTicketId: kind === "blocked_by" ? other.id : ticket.id,
        toTicketId: kind === "blocked_by" ? ticket.id : other.id,
        kind: kind === "relates" ? "relates" : "blocks",
        source: "agent",
      })
      .onConflictDoNothing()
      .returning({ id: ticketLinks.id });
    if (!row) continue; // already proposed or confirmed
    for (const t of [ticket, other])
      await ticketChanged(tx, t, ["links"], { change: "proposed", kind }, actor);
  }

  const results = v.criteriaResults.filter((c) => UUID.test(c.criterionId));
  if (results.length) {
    for (const c of results)
      await tx
        .update(acceptanceCriteria)
        .set({ status: c.status })
        .where(
          and(eq(acceptanceCriteria.id, c.criterionId), eq(acceptanceCriteria.ticketId, ticket.id)),
        );
    await ticketChanged(tx, ticket, ["criteria"], { change: "checked by QA", results }, actor);
  }
}
