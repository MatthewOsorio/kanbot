import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import {
  afterRun,
  BOUNCE_LIMIT,
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
  comments,
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
import { git, loadProjectConfig, projectConfig, type ProjectConfig } from "@kanbot/shared/repo";
import { and, count, eq, max, sql } from "drizzle-orm";
import { buildContext } from "./context";
import { EDIT_TOOLS } from "./runtime/fence";
import { record } from "./runtime/replay";
import type { AgentRuntime, RuntimeEvent, RuntimeResult } from "./runtime/types";
import {
  changedSince,
  checkAfterRun,
  ensureWorktree,
  snapshot,
  WORKTREE_COLUMNS,
} from "./worktree";

export type Run = typeof runs.$inferSelect;

/** Requirements §14 concurrency defaults; per-project settings arrive with the settings table in M4. */
export const LIMITS = { global: 2, perProject: 1 };

/** Stall detection (§8): this many identical tool calls stop a run. */
const STALL_REPEATS = 3;
/** KANBOT_RECORD=1 saves each real run as a replay script (§8 recorded runs). */
const RECORD = process.env.KANBOT_RECORD === "1";
/** Bundled plugins (§8); the worker runs with apps/worker as cwd, like agentsDir(). */
const pluginsDir = () => resolve(process.env.KANBOT_PLUGINS_DIR ?? "../../plugins");

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

const byTicket = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` once the ticket's previous run in this process has fully stopped. A cancel marks the row
 * `cancelled` at once, but the aborted agent can still be writing to the worktree for a moment, and the
 * next column's run is already queued: started early, its snapshot would blame it for those writes.
 */
export function afterPrevious<T>(ticketId: string, fn: () => Promise<T>): Promise<T> {
  const p = (byTicket.get(ticketId) ?? Promise.resolve()).then(fn);
  const settled = p.catch(() => {});
  byTicket.set(ticketId, settled);
  void settled.then(() => byTicket.get(ticketId) === settled && byTicket.delete(ticketId));
  return p;
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
    .select({ ticket: tickets, project: projects })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, run.ticketId));
  if (!row) return; // ticket deleted; the run row went with it (cascade)
  const { ticket, project } = row;
  const key = `${project.keyPrefix}-${ticket.number}`;

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

  const recorded: RuntimeEvent[] = [];
  const calls = new Map<string, number>();
  const stall = new AbortController();
  let seq = 0;
  const emit = async (e: RuntimeEvent) => {
    const n = ++seq;
    if (RECORD) recorded.push(e);
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
    // Stall detection (§8): the same tool call with the same arguments a third time stops the run.
    // shortcut: only the repetition rule; "no progress" and "repeated feedback" arrive with Duckworth (M4).
    // An edit is progress: rerunning the tests after one is not a loop (refused Testy in the M3 golden run).
    if (e.type === "tool_call" && EDIT_TOOLS.has(String(e.payload.name))) calls.clear();
    else if (e.type === "tool_call") {
      const k = JSON.stringify([e.payload.name, e.payload.input]);
      const count = (calls.get(k) ?? 0) + 1;
      calls.set(k, count);
      if (count >= STALL_REPEATS)
        stall.abort(
          `Stopped: the agent made the same ${String(e.payload.name)} call ${count} times`,
        );
    }
  };

  const timeout = AbortSignal.timeout(agent.timeoutMinutes * 60_000);
  const signal = AbortSignal.any([cancel, timeout, stall.signal]);
  // Without a linked repo the agent gets an empty folder rather than the worker's own directory.
  const scratch = project.repoPath ? null : await mkdtemp(join(tmpdir(), "kanbot-norepo-"));
  let result: RuntimeResult;
  let wt: { path: string; branch: string } | null = null;
  let before: Awaited<ReturnType<typeof snapshot>> | null = null;
  let canEdit: ((rel: string) => boolean) | undefined;
  try {
    const config = project.repoPath
      ? await loadProjectConfig(project.repoPath, project.defaultBranch)
      : projectConfig.parse({});
    if (WORKTREE_COLUMNS.has(run.columnSlug)) {
      if (!project.repoPath) throw new Error("Link a local repo to this project before building");
      wt = await ensureWorktree(
        project.repoPath,
        project.defaultBranch,
        { ...ticket, key },
        config,
      );
      if (ticket.worktreePath !== wt.path || ticket.branchName !== wt.branch)
        await db
          .update(tickets)
          .set({ worktreePath: wt.path, branchName: wt.branch })
          .where(eq(tickets.id, ticket.id));
      before = await snapshot(wt.path, project.defaultBranch);
    }
    canEdit = editScope(agent.editScope, config);
    const cwd = wt?.path ?? project.repoPath ?? scratch!;
    const prompt = await buildContext(db, { ...ticket, key }, run, {
      cwd: project.repoPath ? cwd : null,
      defaultBranch: project.defaultBranch,
      hotspots: config.hotspots,
    });
    const scenario = ticket.labels.find((l) => l.startsWith("replay:"))?.slice(7) ?? "default";
    const [{ attempt } = { attempt: 1 }] = await db
      .select({ attempt: count() })
      .from(runs)
      .where(and(eq(runs.ticketId, ticket.id), eq(runs.agentSlug, run.agentSlug)));
    result = await runtime.run(
      {
        agent,
        tools: expandTools(agent.tools, config.commands),
        canEdit,
        plugins: agent.plugins.map((p) => resolve(pluginsDir(), p.name)),
        env: Object.fromEntries(
          agent.plugins
            .filter((p) => p.name === "ponytail" && p.level)
            .map((p) => ["PONYTAIL_DEFAULT_MODE", p.level!]),
        ),
        prompt,
        cwd,
        signal,
        scenario,
        attempt,
      },
      emit,
    );
    if (RECORD && scenario !== "default")
      await record(
        agent.slug,
        scenario,
        attempt,
        recorded,
        result,
        wt && before ? { path: wt.path, base: before.head } : null,
        prompt,
        cwd,
      );
  } catch (e) {
    if (cancel.aborted) return finish(db, run.id, { state: "cancelled" }); // already cancelled by the web app
    if (timeout.aborted)
      return finish(db, run.id, {
        state: "timed_out",
        error: `Timed out after ${agent.timeoutMinutes} min`,
      });
    if (stall.signal.aborted)
      return finish(db, run.id, { state: "awaiting_input", error: String(stall.signal.reason) });
    return finish(db, run.id, { state: "failed", error: (e as Error).message });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  const outcome = outcomeOf(result);
  if (wt && before) {
    const broken = await checkAfterRun(wt, project.defaultBranch, before, canEdit).catch(
      (e: Error) => `Post-run check failed: ${e.message}`,
    );
    if (broken) return finish(db, run.id, { state: "failed", error: broken }, result);
    // The touch set grows with what the branch really changed (§9).
    if (run.columnSlug === "in_progress") {
      const base = await git(wt.path, ["merge-base", project.defaultBranch, "HEAD"]);
      outcome.touched = await changedSince(wt.path, base.trim());
    }
  }
  return finish(db, run.id, outcome, result);
}

type Outcome = {
  state: RunOutcome;
  error?: string;
  verdict?: VerdictPayload;
  /** Files the branch changed (In Progress runs), added to the ticket's touch set. */
  touched?: string[];
};

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
  const v = parsed.data;
  // A blocking cross-ticket risk is a change request, whatever the reviewer concluded (§9).
  if (v.verdict === "success" && v.crossTicketRisks.some((x) => x.severity === "blocking"))
    v.verdict = "changes_requested";
  return { state: stateForVerdict[v.verdict] as RunOutcome, verdict: v };
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
    const rule = afterRun(run.columnSlug, o.state, {
      verdict: o.verdict?.verdict,
      bounces: ticket.bounceCount,
    });
    // Re-read: storeResults may have replaced the touch set (Plan B).
    const [{ touchPaths }] = (await tx
      .select({ touchPaths: tickets.touchPaths })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))) as [{ touchPaths: string[] }];
    await tx
      .update(tickets)
      .set({
        statusFlag: rule.flag,
        bounceCount: ticket.bounceCount + (rule.bounce ? 1 : 0),
        ...(o.touched && { touchPaths: [...new Set([...touchPaths, ...o.touched])] }),
      })
      .where(eq(tickets.id, ticket.id));
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
        ...(rule.bounce && { bounce: ticket.bounceCount + 1 }),
        ...(rule.reason && { reason: `Bounce limit (${BOUNCE_LIMIT}) reached` }),
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

type TicketRef = { id: string; projectId: string };

/** Adds an agent comment, logs it and announces it. */
async function agentComment(
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stores what the verdict carries: artifacts (new versions, never overwriting), Plan B's criteria and
 * touch set, Nancy's line comments and cross-ticket risks, Testy's per-criterion results.
 */
async function storeResults(tx: Tx, ticket: TicketRef, run: Run, v: VerdictPayload) {
  const actor = agentActor(run.agentSlug);
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
    await logActivity(
      tx,
      ticket.id,
      "edited",
      { fields: ["criteria"], change: "replaced by plan", count: v.acceptanceCriteria.length },
      actor,
    );
    await publish(tx, ticket.projectId, {
      type: "ticket.updated",
      ticketId: ticket.id,
      fields: ["criteria"],
    });
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

  if (v.crossTicketRisks.length) {
    const [me] = await tx
      .select({ number: tickets.number, keyPrefix: projects.keyPrefix })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticket.id));
    const myKey = `${me!.keyPrefix}-${me!.number}`;
    for (const r of v.crossTicketRisks) {
      const note = `**Cross-ticket risk (${r.severity}, ${r.kind})**: ${r.description}`;
      await agentComment(tx, ticket, run.agentSlug, { bodyMd: `${r.ticket}: ${note}` });
      // The note goes on the other ticket too (§9); a key from another project is ignored.
      const n = r.ticket.startsWith(`${me!.keyPrefix}-`) ? Number(r.ticket.split("-").pop()) : NaN;
      const [other] = Number.isInteger(n)
        ? await tx
            .select({ id: tickets.id, projectId: tickets.projectId })
            .from(tickets)
            .where(and(eq(tickets.projectId, ticket.projectId), eq(tickets.number, n)))
        : [];
      if (other && other.id !== ticket.id)
        await agentComment(tx, other, run.agentSlug, { bodyMd: `${myKey}: ${note}` });
    }
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
    await logActivity(
      tx,
      ticket.id,
      "edited",
      { fields: ["criteria"], change: "checked by QA", results },
      actor,
    );
    await publish(tx, ticket.projectId, {
      type: "ticket.updated",
      ticketId: ticket.id,
      fields: ["criteria"],
    });
  }
}

/** `{test}`-style placeholders → the project's commands; an entry naming a missing command is dropped. */
export function expandTools(tools: readonly string[], commands: ProjectConfig["commands"]) {
  return tools.flatMap((t) => {
    let missing = false;
    const out = t.replace(/\{(install|build|test|lint)\}/g, (_, k: keyof typeof commands) => {
      const c = commands[k];
      if (!c) missing = true;
      return c ?? "";
    });
    return missing ? [] : [out];
  });
}

/** The agent's edit scope (§14) as a path predicate; undefined = anywhere in the worktree. */
function editScope(scope: AgentConfig["editScope"], config: ProjectConfig) {
  if (scope === "worktree") return undefined;
  if (scope === "none") return () => false;
  return (rel: string) => config.testGlobs.some((g) => matchesGlob(rel, g));
}
