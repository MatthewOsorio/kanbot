import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
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
  activeRun,
  artifacts,
  columns,
  comments,
  getSettings,
  logActivity,
  moveToColumnEnd,
  projects,
  publish,
  runEvents,
  runs,
  spendToday,
  startColumnAgent,
  ticketLinks,
  tickets,
  projectConfigOf,
  updateSettings,
  type Db,
  type Tx,
} from "@kanbot/shared/db";
import { botIdentity, decryptEnv, loadGitHubApp, repoToken } from "@kanbot/shared/github";
import { baselineFailures, QA_SETUP_MESSAGE, qaRunnable } from "@kanbot/shared/onboarding";
import { git, removeWorktree, type ProjectConfig } from "@kanbot/shared/repo";
import { and, count, desc, eq, isNotNull, max, ne, sql } from "drizzle-orm";
import { buildContext } from "./context";
import { EDIT_TOOLS } from "./runtime/fence";
import { record, redactText } from "./runtime/replay";
import type { AgentRuntime, RuntimeEvent, RuntimeResult } from "./runtime/types";
import { pushAndOpenPr, type ShippedPr } from "./ship";
import {
  changedSince,
  checkAfterRun,
  commitAs,
  runChecks,
  startApp,
  containerBash,
  projectImage,
  pullImage,
  removeContainers,
  ensureWorktree,
  openEnv,
  snapshot,
  WORKTREE_COLUMNS,
} from "./worktree";

export type Run = typeof runs.$inferSelect;

/** Requirements §14 concurrency defaults; a project's settings.concurrency overrides perProject. */
export const LIMITS = { global: 2, perProject: 1 };

/** Stall detection (§8): this many identical tool calls stop a run. */
const STALL_REPEATS = 3;
/** "About 15 turns" with no progress (§8); a turn often makes a few calls. Golden runs peak at 5. */
const NO_PROGRESS_CALLS = 25;
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
    // Pause all (FR-63) and the daily cap (§14): nothing new starts.
    const s = await getSettings(tx);
    const { spent, reserved } = await spendToday(tx);
    const left = s.dailyBudgetUsd - spent - reserved;
    if (s.paused || left < 0.01) return null; // the cap is in cents, spend in hundredths of a cent
    const res = await tx.execute<{ id: string }>(sql`
      update runs set state = 'running', started_at = now()
      where id = (
        select r.id from runs r join tickets t on t.id = r.ticket_id
        where r.state = 'queued'
          and (select count(*) from runs where state = 'running') < ${LIMITS.global}
          and (select count(*) from runs r2 join tickets t2 on t2.id = r2.ticket_id
               where r2.state = 'running' and t2.project_id = t.project_id) < coalesce((select (p.settings->>'concurrency')::int from projects p where p.id = t.project_id), ${LIMITS.perProject})
        order by r.created_at
        limit 1
        for update of r skip locked)
      returning id`);
    const id = res.rows[0]?.id;
    if (!id) return null;
    const [claimed] = await tx.select().from(runs).where(eq(runs.id, id));
    let agentBudget = left;
    try {
      agentBudget = loadAgent(claimed!.agentSlug)?.maxBudgetUsd ?? left;
    } catch {
      // invalid agent file: execute() fails the run with the validation error
    }
    const [run] = await tx
      .update(runs)
      .set({ budgetUsd: Math.min(agentBudget, left) })
      .where(eq(runs.id, id))
      .returning();
    return run!;
  });
}

/** Error of a run stopped by Pause all; such runs, like outage ones, restart on their own (§8). */
export const PAUSED_ERROR = "Stopped by Pause all";
const API_ERROR = "Anthropic API error";

/**
 * Restarts runs that an outage or Pause all interrupted (requirements §8 failure handling), once agents
 * aren't paused and `reachable()` (the Anthropic probe) says the API is back. Only a ticket's latest run,
 * still in its column with nothing active, restarts: anything the owner did since wins.
 */
export async function resumeInterrupted(db: Db, reachable: () => Promise<boolean>) {
  const candidates = await db.execute<{ id: string }>(sql`
    select r.id from runs r
    join tickets t on t.id = r.ticket_id
    join columns c on c.id = t.column_id and c.slug = r.column_slug
    where r.state = 'interrupted'
      and (r.error = ${PAUSED_ERROR} or r.error like ${`${API_ERROR}%`})
      and not exists (select 1 from runs r2 where r2.ticket_id = r.ticket_id and r2.created_at > r.created_at)`);
  if (!candidates.rows.length) return 0;
  if ((await getSettings(db)).paused || !(await reachable())) return 0;
  let n = 0;
  for (const { id } of candidates.rows)
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: runs, ticket: tickets, column: columns })
        .from(runs)
        .innerJoin(tickets, eq(tickets.id, runs.ticketId))
        .innerJoin(columns, eq(columns.id, tickets.columnId))
        .where(eq(runs.id, id))
        .for("update", { of: tickets });
      // Re-checked under the ticket lock: the owner may have moved, retried or deleted it meanwhile.
      if (!row || row.column.slug !== row.run.columnSlug || (await activeRun(tx, row.ticket.id)))
        return;
      const [newer] = await tx
        .select({ id: runs.id })
        .from(runs)
        // In SQL: a JS Date drops the microseconds, so the run would count as newer than itself.
        .where(
          and(
            eq(runs.ticketId, row.ticket.id),
            sql`${runs.createdAt} > (select created_at from runs where id = ${id})`,
          ),
        )
        .limit(1);
      if (newer) return;
      const started = await startColumnAgent(
        tx,
        row.ticket.projectId,
        row.ticket.id,
        row.column,
        agentActor(row.run.agentSlug),
      );
      if (started) n++;
    });
  return n;
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

/**
 * Secrets never reach stored run events (requirements §14). NUL characters are dropped too: Postgres
 * jsonb rejects `\u0000`, so one in a tool's output would fail the run mid-way.
 */
const redact = (payload: Record<string, unknown>, secrets: string[]) =>
  JSON.parse(
    redactText(
      JSON.stringify(payload, (_, v: unknown) =>
        typeof v === "string" ? v.replaceAll("\0", "") : v,
      ),
      secrets,
    ),
  ) as Record<string, unknown>;

/** Executes a claimed run end to end. `cancel` aborts when the owner cancels or moves the ticket. */
export async function executeRun(db: Db, runtime: AgentRuntime, run: Run, cancel: AbortSignal) {
  try {
    await execute(db, runtime, run, cancel);
  } catch (e) {
    // A throw after the agent stopped (a git command, finish's transaction) would leave the run
    // `running`, holding the project's only slot until the worker restarts.
    console.error(`run ${run.id} crashed`, e);
    // drizzle's own message repeats the query's parameters, which may hold the very value Postgres refused.
    const err = e as Error & { cause?: Error };
    await finish(db, run.id, {
      state: "failed",
      error: `Kanbot failed to record this run: ${(err.cause ?? err).message.replaceAll("\0", "")}`,
    });
  }
}

async function execute(db: Db, runtime: AgentRuntime, run: Run, cancel: AbortSignal) {
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

  // The daily cap (§14) can leave less than the agent's own budget.
  const dayCapped = run.budgetUsd != null && run.budgetUsd < agent.maxBudgetUsd;
  if (dayCapped) agent = { ...agent, maxBudgetUsd: run.budgetUsd! };

  const recorded: RuntimeEvent[] = [];
  const calls = new Map<string, number>();
  const stall = new AbortController();
  let seq = 0;
  let idle = 0;
  let testCommand: string | undefined;
  let sessionId: string | undefined;
  // The project's env var values (§10), redacted from everything this run stores; set before the agent starts.
  let secrets: string[] = [];
  const emit = async (e: RuntimeEvent) => {
    const n = ++seq;
    if (RECORD) recorded.push(e);
    await db.transaction(async (tx) => {
      await tx
        .insert(runEvents)
        .values({ runId: run.id, seq: n, type: e.type, payload: redact(e.payload, secrets) });
      await publish(tx, ticket.projectId, {
        type: "run.event",
        runId: run.id,
        ticketId: ticket.id,
        seq: n,
        eventType: e.type,
      });
    });
    if (
      e.type === "system" &&
      e.payload.subtype === "init" &&
      typeof e.payload.sessionId === "string"
    )
      sessionId = e.payload.sessionId;
    // Stall detection (§8). Repetition: the same tool call with the same arguments a third time.
    // An edit is progress: rerunning the tests after one is not a loop (refused Testy in the M3 golden run).
    // shortcut: no "repeated feedback" rule yet (M6); the bounce limit bounds those loops meanwhile.
    if (e.type !== "tool_call") return;
    const name = String(e.payload.name);
    const input = e.payload.input as { command?: unknown; method?: unknown } | null;
    const command = String(input?.command ?? "");
    // A request that changes the app's state is progress too: GET, POST, GET again is not a loop.
    const http = name === "mcp__kanbot__http_request";
    const changesApp =
      http && !["GET", "HEAD", "OPTIONS", undefined].includes(input?.method as string);
    if (EDIT_TOOLS.has(name) || changesApp) calls.clear();
    else {
      const k = JSON.stringify([name, e.payload.input]);
      const count = (calls.get(k) ?? 0) + 1;
      calls.set(k, count);
      if (count >= STALL_REPEATS)
        stall.abort(`Stopped: the agent made the same ${name} call ${count} times`);
    }
    // No progress: agents that may edit, this many calls with no edit and no test run.
    const progress =
      EDIT_TOOLS.has(name) || http || (!!testCommand && command.includes(testCommand));
    idle = progress ? 0 : idle + 1;
    if (agent.editScope !== "none" && idle >= NO_PROGRESS_CALLS)
      stall.abort(`Stopped: ${idle} tool calls with no file change and no test run`);
  };

  const timeout = AbortSignal.timeout(agent.timeoutMinutes * 60_000);
  const signal = AbortSignal.any([cancel, timeout, stall.signal]);
  // Without a linked repo the agent gets an empty folder rather than the worker's own directory.
  const scratch = project.repoPath ? null : await mkdtemp(join(tmpdir(), "kanbot-norepo-"));
  let result: RuntimeResult;
  let wt: { path: string; branch: string } | null = null;
  let before: Awaited<ReturnType<typeof snapshot>> | null = null;
  let canEdit: ((rel: string) => boolean) | undefined;
  let config: ProjectConfig | undefined;
  let app: { url: string; stop: () => Promise<void> } | undefined;
  let env: Awaited<ReturnType<typeof openEnv>> | undefined;
  try {
    config = await projectConfigOf(db, project);
    env = await openEnv(decryptEnv(project.env));
    secrets = Object.values(env.vars);
    testCommand = config.commands.test;
    // FR-49: a ticket reaching Done loses its worktree (the branch stays) before Archie reads the checkout.
    if (run.columnSlug === "done" && ticket.worktreePath && project.repoPath)
      if (await removeWorktree(project.repoPath, ticket.worktreePath))
        await db.update(tickets).set({ worktreePath: null }).where(eq(tickets.id, ticket.id));
    if (WORKTREE_COLUMNS.has(run.columnSlug)) {
      if (!project.repoPath) throw new Error("Link a local repo to this project before building");
      // Builds the devcontainer's image when the project has no Image of its own (§7).
      config = {
        ...config,
        image: await projectImage(
          project.repoPath,
          project.defaultBranch,
          config,
          project.keyPrefix,
        ),
      };
      if (config.image) await pullImage(config.image);
      wt = await ensureWorktree(
        project.repoPath,
        project.defaultBranch,
        { ...ticket, key },
        config,
        env,
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
    // QA checks the criteria against the running app (§4); one that won't start is for Testy to report.
    let appError: string | undefined;
    if (run.columnSlug === "qa" && wt && config.commands.start) {
      const started = await startApp(config.commands.start, wt.path, config.image, env);
      if ("url" in started) app = started;
      else appError = started.error;
    }
    const prompt = await buildContext(db, { ...ticket, key }, run, {
      cwd: project.repoPath ? cwd : null,
      defaultBranch: project.defaultBranch,
      hotspots: config.hotspots,
      commands: config.commands,
      testGlobs: config.testGlobs,
      baselineFailures: baselineFailures(project.baseline),
      app: app ? { url: app.url } : appError ? { error: appError } : undefined,
    });
    // FR-42: agents' commits carry trailers and, on a GitHub project, the App's bot as author.
    const ghApp =
      project.githubRepo && agent.tools.some((t) => t.startsWith("Bash(git commit"))
        ? await loadGitHubApp(db)
        : null;
    const commit = commitAs(
      agent.slug,
      key,
      ghApp
        ? await botIdentity(
            ghApp,
            await repoToken(ghApp, project.githubOwner!, project.githubRepo!),
          )
        : undefined,
    );
    const container = config.image
      ? containerBash(config.image, cwd, config.commands, run.id, env.file)
      : undefined;
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
        resumeSessionId: run.resumeSessionId ?? undefined,
        appUrl: app?.url,
        // Project commands the agent runs go to the project's image (§7).
        bash: (c) => commit(c) ?? container?.(c) ?? null,
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
        secrets,
      );
  } catch (e) {
    const stop = (o: Outcome) => finish(db, run.id, { ...o, sessionId });
    // Pause all leaves the run `running` for us to mark; a cancel was already written by the web app.
    if (cancel.aborted)
      return stop(
        cancel.reason === PAUSED_ERROR
          ? { state: "interrupted", error: PAUSED_ERROR }
          : { state: "cancelled" },
      );
    if (timeout.aborted)
      return stop({
        state: "timed_out",
        error: `Timed out after ${agent.timeoutMinutes} min`,
      });
    if (stall.signal.aborted)
      return stop({ state: "awaiting_input", error: String(stall.signal.reason) });
    return stop({ state: "failed", error: redactText((e as Error).message, secrets) });
  } finally {
    await app?.stop().catch(() => {});
    // Containers of agent commands the Bash tool's timeout or a cancel left running.
    if (config?.image) await removeContainers(["--filter", `label=kanbot=${run.id}`]);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await env?.dispose();
  }

  const outcome = outcomeOf(result);
  if (dayCapped && outcome.state === "budget_exceeded")
    outcome.error = `Daily budget reached: this run could spend only $${run.budgetUsd!.toFixed(2)} of what was left today`;
  if (wt && before) {
    // Who changed what (Diff tab); kept even when the checks below fail, since the changes stay on the branch.
    const mine = await changedSince(wt.path, before.head).catch(() => []);
    outcome.filesChanged = mine.filter((f) => !before!.dirty.includes(f));
    const broken = await checkAfterRun(wt, project.defaultBranch, before, canEdit).catch(
      (e: Error) => `Post-run check failed: ${e.message}`,
    );
    if (broken)
      return finish(
        db,
        run.id,
        { state: "failed", error: broken, filesChanged: outcome.filesChanged },
        result,
      );
    // The touch set grows with what the branch really changed (§9).
    if (run.columnSlug === "in_progress") {
      const base = await git(wt.path, ["merge-base", project.defaultBranch, "HEAD"]);
      outcome.touched = await changedSince(wt.path, base.trim());
    }
    if (run.columnSlug === "in_progress" || run.columnSlug === "ship") {
      // The checks gate (§8): a branch that doesn't build, lint and test goes back before review,
      // and before Ship pushes it (Ship-It's docs edits run them again).
      if (outcome.state === "succeeded" && config) {
        const checksEnv = await openEnv(decryptEnv(project.env));
        const failed = await runChecks(
          config.commands,
          wt.path,
          config.image,
          baselineFailures(project.baseline),
          checksEnv,
        ).finally(() => checksEnv.dispose());
        if (failed) {
          outcome.state = "changes_requested";
          outcome.error = `Kanbot checks: \`${failed.command}\` failed`;
          outcome.checks = { ...failed, output: redactText(failed.output, secrets) };
        }
      }
    }
    if (run.columnSlug === "ship" && outcome.state === "succeeded" && project.githubRepo) {
      const description =
        outcome.verdict?.artifacts.find((a) => a.kind === "pr_description")?.markdown ??
        outcome.verdict?.summary ??
        "";
      try {
        outcome.pr = await pushAndOpenPr(
          db,
          { ...project, githubOwner: project.githubOwner!, githubRepo: project.githubRepo },
          { key, title: ticket.title, prNumber: ticket.prNumber },
          wt,
          description,
        );
      } catch (e) {
        return finish(
          db,
          run.id,
          {
            state: "failed",
            verdict: outcome.verdict,
            error: `Couldn't push or open the PR: ${redactText((e as Error).message, secrets)}`,
            filesChanged: outcome.filesChanged,
          },
          result,
        );
      }
    }
  }
  return finish(db, run.id, outcome, result);
}

type Outcome = {
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
    const error = `${API_ERROR}: ${r.apiError ?? "unknown"}${r.error ? ` (${r.error})` : ""}`;
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

const agentActor = (slug: string) => ({ kind: "agent" as const, name: slug });

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
        .set({ prNumber: o.pr.number, prUrl: o.pr.url, headSha: o.pr.headSha })
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
    let started = null;
    const next = rule.rerun ? from : to && to.id !== from.id ? to : null;
    if (next) {
      if (next.id !== from.id) await moveToColumnEnd(tx, ticket, from, next, actor);
      // A bounce resumes the agent's last session there, so it picks up where it left off (FR-35).
      const [last] = rule.bounce
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
      started = await startColumnAgent(tx, ticket.projectId, ticket.id, next, actor, {
        resumeSessionId: last?.sessionId,
      });
    }
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

/** A new artifact version (never overwriting) and its event. */
async function storeArtifact(
  tx: Tx,
  ticket: TicketRef,
  run: Run,
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
      runId: run.id,
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
async function storeResults(tx: Tx, ticket: TicketRef, run: Run, v: VerdictPayload) {
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
    for (const t of [ticket, other]) {
      await logActivity(tx, t.id, "edited", { fields: ["links"], change: "proposed", kind }, actor);
      await publish(tx, t.projectId, { type: "ticket.updated", ticketId: t.id, fields: ["links"] });
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
  if (scope === "docs") return (rel: string) => rel.endsWith(".md") || rel.startsWith("docs/");
  return (rel: string) => config.testGlobs.some((g) => matchesGlob(rel, g));
}
