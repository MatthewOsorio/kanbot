import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterRun,
  stateForVerdict,
  verdictPayload,
  type RunOutcome,
  type VerdictPayload,
} from "@kanbot/shared";
import { loadAgent, type AgentConfig } from "@kanbot/shared/agents";
import {
  acceptanceCriteria,
  artifacts,
  columns,
  logActivity,
  moveToColumnEnd,
  projects,
  publish,
  runEvents,
  runs,
  startColumnAgent,
  tickets,
  type Db,
  type Tx,
} from "@kanbot/shared/db";
import { and, eq, max, sql } from "drizzle-orm";
import { buildContext } from "./context";
import type { AgentRuntime, RuntimeEvent, RuntimeResult } from "./runtime/types";

export type Run = typeof runs.$inferSelect;

/** Requirements §14 concurrency defaults; per-project settings arrive with project settings in M3. */
export const LIMITS = { global: 2, perProject: 1 };

/**
 * Claims the oldest queued run that fits the concurrency limits (requirements §8 step 2).
 * Only `queued` rows are claimed, so a run is never executed twice. The advisory lock makes the
 * limit checks exact even if two claims race.
 */
export async function claimNext(db: Db): Promise<Run | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kanbot_claim'))`);
    const res = await tx.execute<{ id: string }>(sql`
      update runs set state = 'running', started_at = now()
      where id = (
        select r.id from runs r join tickets t on t.id = r.ticket_id
        where r.state = 'queued'
          and (select count(*) from runs where state = 'running') < ${LIMITS.global}
          and (select count(*) from runs r2 join tickets t2 on t2.id = r2.ticket_id
               where r2.state = 'running' and t2.project_id = t.project_id) < ${LIMITS.perProject}
        order by r.created_at
        limit 1
        for update of r skip locked)
      returning id`);
    const id = res.rows[0]?.id;
    if (!id) return null;
    const [run] = await tx.select().from(runs).where(eq(runs.id, id));
    return run!;
  });
}

/** Crash recovery (requirements §8): runs left `running` by a dead worker become `interrupted`. */
export async function recoverInterrupted(db: Db) {
  const stale = await db.select({ id: runs.id }).from(runs).where(eq(runs.state, "running"));
  for (const { id } of stale)
    await finish(db, id, {
      state: "interrupted",
      error: "The worker stopped while this run was in progress",
    });
  return stale.length;
}

const secret = process.env.ANTHROPIC_API_KEY;
/** Secrets never reach stored run events (requirements §14). */
const redact = (payload: Record<string, unknown>): Record<string, unknown> =>
  secret && secret.length >= 8
    ? (JSON.parse(JSON.stringify(payload).replaceAll(secret, "[redacted]")) as Record<
        string,
        unknown
      >)
    : payload;

/** Executes a claimed run end to end. `cancel` aborts when the owner cancels or moves the ticket. */
export async function executeRun(db: Db, runtime: AgentRuntime, run: Run, cancel: AbortSignal) {
  const [row] = await db
    .select({ ticket: tickets, keyPrefix: projects.keyPrefix, repoPath: projects.repoPath })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, run.ticketId));
  if (!row) return; // ticket deleted; the run row went with it (cascade)
  const { ticket } = row;

  let agent: AgentConfig | null;
  try {
    agent = loadAgent(run.agentSlug);
    if (!agent) throw new Error(`agents/${run.agentSlug}.md no longer exists`);
  } catch (e) {
    return finish(db, run.id, {
      state: "failed",
      error: `Invalid agent file: ${(e as Error).message}`,
    });
  }

  let seq = 0;
  const emit = async (e: RuntimeEvent) => {
    const n = ++seq;
    await db.transaction(async (tx) => {
      await tx
        .insert(runEvents)
        .values({ runId: run.id, seq: n, type: e.type, payload: redact(e.payload) });
      await publish(tx, ticket.projectId, {
        type: "run.event",
        runId: run.id,
        ticketId: ticket.id,
        seq: n,
        eventType: e.type,
      });
    });
  };

  const timeout = AbortSignal.timeout(agent.timeoutMinutes * 60_000);
  const signal = AbortSignal.any([cancel, timeout]);
  // Without a linked repo the agent gets an empty folder rather than the worker's own directory.
  const scratch = row.repoPath ? null : await mkdtemp(join(tmpdir(), "kanbot-norepo-"));
  let result: RuntimeResult;
  try {
    const prompt = await buildContext(
      db,
      { ...ticket, key: `${row.keyPrefix}-${ticket.number}` },
      run,
      row.repoPath,
    );
    const scenario = ticket.labels.find((l) => l.startsWith("replay:"))?.slice(7) ?? "default";
    result = await runtime.run(
      { agent, prompt, cwd: row.repoPath ?? scratch!, signal, scenario },
      emit,
    );
  } catch (e) {
    if (cancel.aborted) return finish(db, run.id, { state: "cancelled" }); // already cancelled by the web app
    if (timeout.aborted)
      return finish(db, run.id, {
        state: "timed_out",
        error: `Timed out after ${agent.timeoutMinutes} min`,
      });
    return finish(db, run.id, { state: "failed", error: (e as Error).message });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
  return finish(db, run.id, outcomeOf(result), result);
}

type Outcome = { state: RunOutcome; error?: string; verdict?: VerdictPayload };

/** Maps the runtime's result to a run state (requirements §8 report step and failure handling). */
export function outcomeOf(r: RuntimeResult): Outcome {
  if (r.stop === "budget")
    return { state: "budget_exceeded", error: r.error ?? "Run budget exceeded" };
  if (r.stop === "max_turns") return { state: "failed", error: "Reached the agent's max turns" };
  if (r.stop === "api_error") {
    // The SDK already retried; an outage leaves the ticket in place with Retry. Auth/billing fail outright.
    const transient = ["rate_limit", "overloaded", "server_error"].includes(r.apiError ?? "");
    return {
      state: transient ? "interrupted" : "failed",
      error: `Anthropic API error: ${r.apiError ?? "unknown"}${r.error ? ` (${r.error})` : ""}`,
    };
  }
  if (r.stop === "error") return { state: "failed", error: r.error ?? "The agent run failed" };
  if (r.report == null)
    return { state: "failed", error: "The run ended without calling report_result" };
  const parsed = verdictPayload.safeParse(r.report);
  if (!parsed.success)
    return { state: "failed", error: `Invalid report_result payload: ${parsed.error.message}` };
  return { state: stateForVerdict[parsed.data.verdict] as RunOutcome, verdict: parsed.data };
}

const agentActor = (slug: string) => ({ kind: "agent" as const, name: slug });

/**
 * Records the run's end and applies the transition table, in one transaction (§8 steps 5–6).
 * A run the owner already cancelled keeps its `cancelled` state; only its usage is recorded.
 */
export async function finish(db: Db, runId: string, o: Outcome, usage?: RuntimeResult) {
  await db.transaction(async (tx) => {
    const usageFields = usage
      ? {
          sessionId: usage.sessionId ?? null,
          costUsd: usage.costUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }
      : {};
    const [run] = await tx
      .update(runs)
      .set({
        ...usageFields,
        state: o.state,
        verdict: o.verdict?.verdict ?? null,
        summary: o.verdict?.summary ?? null,
        error: o.error ?? null,
        endedAt: new Date(),
      })
      .where(and(eq(runs.id, runId), eq(runs.state, "running")))
      .returning();
    if (!run) {
      if (usage) await tx.update(runs).set(usageFields).where(eq(runs.id, runId));
      return;
    }
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, run.ticketId))
      .for("update");
    if (!ticket) return;
    const actor = agentActor(run.agentSlug);
    if (o.verdict) await storeResults(tx, ticket, run, o.verdict);

    const cols = await tx.select().from(columns).where(eq(columns.projectId, ticket.projectId));
    const from = cols.find((c) => c.id === ticket.columnId)!;
    const rule = afterRun(run.columnSlug, o.state);
    await tx.update(tickets).set({ statusFlag: rule.flag }).where(eq(tickets.id, ticket.id));
    await logActivity(
      tx,
      ticket.id,
      "run_finished",
      {
        runId,
        agent: run.agentSlug,
        state: o.state,
        verdict: o.verdict?.verdict,
        summary: run.summary,
        error: o.error,
        costUsd: run.costUsd,
      },
      actor,
    );
    await publish(tx, ticket.projectId, {
      type: "run.finished",
      runId,
      ticketId: ticket.id,
      agentSlug: run.agentSlug,
      state: o.state,
      verdict: o.verdict?.verdict,
      costUsd: run.costUsd,
    });
    const to = rule.to && cols.find((c) => c.slug === rule.to);
    if (to && to.id !== from.id) {
      await moveToColumnEnd(tx, ticket, from, to, actor);
      await startColumnAgent(tx, ticket.projectId, ticket.id, to, actor);
    }
  });
}

/** Stores the verdict's artifacts (new versions, never overwriting) and agent-written criteria. */
async function storeResults(
  tx: Tx,
  ticket: { id: string; projectId: string },
  run: Run,
  v: VerdictPayload,
) {
  for (const a of v.artifacts) {
    const [{ last } = { last: null }] = await tx
      .select({ last: max(artifacts.version) })
      .from(artifacts)
      .where(and(eq(artifacts.ticketId, ticket.id), eq(artifacts.kind, a.kind)));
    const [row] = await tx
      .insert(artifacts)
      .values({
        ticketId: ticket.id,
        runId: run.id,
        kind: a.kind,
        title: a.title,
        version: (last ?? 0) + 1,
        contentMd: a.markdown,
      })
      .returning({ id: artifacts.id });
    await publish(tx, ticket.projectId, {
      type: "artifact.created",
      ticketId: ticket.id,
      artifactId: row!.id,
    });
  }
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
    await logActivity(
      tx,
      ticket.id,
      "edited",
      { fields: ["criteria"], change: "replaced by plan", count: v.acceptanceCriteria.length },
      agentActor(run.agentSlug),
    );
    await publish(tx, ticket.projectId, {
      type: "ticket.updated",
      ticketId: ticket.id,
      fields: ["criteria"],
    });
  }
}
