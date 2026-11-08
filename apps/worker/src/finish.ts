// The end of a run: its state from the runtime's result, then the transition table, in one transaction (§8 steps 5–6).
import {
  afterRun,
  ANTHROPIC_API_ERROR,
  stateForVerdict,
  verdictPayload,
  type RunOutcome,
  type VerdictPayload,
} from "@kanbot/shared";
import {
  columns,
  logActivity,
  moveToColumnEnd,
  projects,
  publish,
  runs,
  startColumnAgent,
  tickets,
  projectConfigOf,
  updateSettings,
  type Db,
  type Tx,
  agentActor,
} from "@kanbot/shared/db";
import { QA_SETUP_MESSAGE, qaRunnable } from "@kanbot/shared/onboarding";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { RuntimeResult } from "./runtime/types";
import { type ShippedPr } from "./ship";
import { storeResults, storeArtifact, agentComment, type TicketRef } from "./results";

export type Outcome = {
  state: RunOutcome;
  error?: string;
  /** Pause all agents with this reason (auth or billing errors: every run would fail the same way). */
  pause?: string;
  verdict?: VerdictPayload;
  /** Files the branch changed (In Progress runs), added to the ticket's touch set. */
  touched?: string[];
  /** Files this run itself changed in the worktree, stored on the run. */
  filesChanged?: string[];
  /** The agent session of a run stopped before it reported (kept for Resume). */
  sessionId?: string;
  /** The checks gate's failure, stored as a test report for the builder's next run. */
  checks?: { command: string; output: string };
  /** The PR the worker pushed and opened after a Ship run (FR-43). */
  pr?: ShippedPr;
};

/** Maps the runtime's result to a run state (requirements §8 report step and failure handling). */
export function outcomeOf(r: RuntimeResult): Outcome {
  if (r.stop === "budget")
    return { state: "budget_exceeded", error: r.error ?? "Run budget exceeded" };
  if (r.stop === "max_turns") return { state: "failed", error: "Reached the agent's max turns" };
  if (r.stop === "api_error") {
    // The SDK already retried; an outage leaves the ticket in place with Retry. Auth/billing fail outright.
    const transient = ["rate_limit", "overloaded", "server_error"].includes(r.apiError ?? "");
    const account = ["authentication_failed", "billing_error"].includes(r.apiError ?? "");
    const error = `${ANTHROPIC_API_ERROR}: ${r.apiError ?? "unknown"}${r.error ? ` (${r.error})` : ""}`;
    return { state: transient ? "interrupted" : "failed", error, ...(account && { pause: error }) };
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

/**
 * Records the run's end and applies the transition table, in one transaction (§8 steps 5–6).
 * A run the owner already cancelled keeps its `cancelled` state; only its usage is recorded.
 */
export async function finish(db: Db, runId: string, o: Outcome, usage?: RuntimeResult) {
  await db.transaction(async (tx) => {
    const usageFields = {
      ...(usage && {
        sessionId: usage.sessionId ?? null,
        costUsd: usage.costUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
      ...(o.sessionId && { sessionId: o.sessionId }),
      ...(o.filesChanged && { filesChanged: o.filesChanged }),
    };
    // Ticket before run, the order the web app's move, cancel and delete lock in (else they can deadlock).
    await tx.execute(
      sql`select 1 from tickets where id = (select ticket_id from runs where id = ${runId}) for update`,
    );
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
      if (Object.keys(usageFields).length)
        await tx.update(runs).set(usageFields).where(eq(runs.id, runId));
      return;
    }
    if (o.pause) {
      await updateSettings(tx, { paused: true, pausedReason: o.pause });
      await publish(tx, "*", {
        type: "notification",
        kind: "paused",
        message: `Agents paused: ${o.pause}`,
      });
    }
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, run.ticketId));
    if (!ticket) return;
    const actor = agentActor(run.agentSlug);
    if (o.verdict) await storeResults(tx, ticket, run, o.verdict);
    if (o.checks)
      await storeArtifact(tx, ticket, run, {
        kind: "test_report",
        title: `Kanbot checks: \`${o.checks.command}\` failed`,
        markdown: `Kanbot ran \`${o.checks.command}\` in the worktree after this run, and it failed. Fix it before review.\n\n\`\`\`\n${o.checks.output.replaceAll("```", "'''")}\n\`\`\``,
      });

    if (o.pr) {
      await tx
        .update(tickets)
        // A new head: CI starts over (the GitHub watcher, FR-46).
        .set({ prNumber: o.pr.number, prUrl: o.pr.url, headSha: o.pr.headSha, ciState: "pending" })
        .where(eq(tickets.id, ticket.id));
      await logActivity(
        tx,
        ticket.id,
        "pr_opened",
        { number: o.pr.number, url: o.pr.url, updated: ticket.prNumber === o.pr.number },
        actor,
      );
    }
    const cols = await tx.select().from(columns).where(eq(columns.projectId, ticket.projectId));
    const from = cols.find((c) => c.id === ticket.columnId)!;
    const [project] = await tx.select().from(projects).where(eq(projects.id, ticket.projectId));
    const config = await projectConfigOf(tx, project!);
    let rule = afterRun(run.columnSlug, o.state, {
      verdict: o.verdict?.verdict,
      bounces: ticket.bounceCount,
      bounceLimit: config.bounceLimit,
    });
    // §4: QA without the app running would only read the code, so the ticket waits here for a start command.
    const noQa = rule.to === "qa" && !!project!.repoPath && !qaRunnable(config);
    if (noQa) rule = { to: null, flag: "needs_input", bounce: false };
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
        ...(rule.reason && { reason: `Bounce limit (${config.bounceLimit}) reached` }),
        ...(noQa && { reason: QA_SETUP_MESSAGE }),
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
    if (
      run.columnSlug === "blocked" &&
      !["succeeded", "cancelled", "interrupted"].includes(o.state)
    )
      await duckworthFallback(tx, ticket);
    const to = rule.to && cols.find((c) => c.slug === rule.to);
    const next = rule.rerun ? from : to && to.id !== from.id ? to : null;
    const started = next ? await moveAndStart(tx, ticket, from, next, actor, rule.bounce) : null;
    // The ticket now waits for the owner, with no agent left to run (FR-60).
    if (!started && ["needs_input", "failed"].includes(rule.flag) && o.state !== "interrupted")
      await publish(tx, ticket.projectId, {
        type: "notification",
        kind: rule.flag as "needs_input" | "failed",
        ticketId: ticket.id,
        message: noQa
          ? `${ticket.title}: ${QA_SETUP_MESSAGE}, then drag it to QA`
          : `${ticket.title}: blocked, needs your answer`,
      });
  });
}

/**
 * An automatic move (after a run, or a GitHub event): to the bottom of `next` unless it's the same column,
 * then `next`'s agent. A bounce resumes the agent's last session there, so it picks up where it left off (FR-35).
 */
export async function moveAndStart(
  tx: Tx,
  ticket: TicketRef,
  from: typeof columns.$inferSelect,
  next: typeof columns.$inferSelect,
  actor: { kind: "user" | "agent"; name: string },
  bounce: boolean,
) {
  if (next.id !== from.id) await moveToColumnEnd(tx, ticket, from, next, actor);
  const [last] = bounce
    ? await tx
        .select({ sessionId: runs.sessionId })
        .from(runs)
        .where(
          and(
            eq(runs.ticketId, ticket.id),
            eq(runs.columnSlug, next.slug),
            isNotNull(runs.sessionId),
          ),
        )
        .orderBy(desc(runs.createdAt))
        .limit(1)
    : [];
  return startColumnAgent(tx, ticket.projectId, ticket.id, next, actor, {
    resumeSessionId: last?.sessionId,
  });
}

/** Duckworth's run failed (§8): post the blocking run's last error and verdict so the owner has something. */
async function duckworthFallback(tx: Tx, ticket: TicketRef) {
  const [b] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.ticketId, ticket.id), ne(runs.columnSlug, "blocked")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (!b) return;
  await agentComment(tx, ticket, "rubber-duckworth", {
    bodyMd: [
      `Quack. I couldn't write a blocker summary, so here is what I know. **${b.agentSlug}** ended as \`${b.state}\`${b.verdict ? ` (verdict \`${b.verdict}\`)` : ""}.`,
      b.error && `Error: ${b.error}`,
      b.summary && `Summary: ${b.summary}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}
