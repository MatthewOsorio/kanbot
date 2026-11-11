import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import {
  agentActor,
  type AgentConfig,
  botIdentity,
  type Db,
  decryptEnv,
  git,
  loadAgent,
  loadGitHubApp,
  type ProjectConfig,
  projectConfigOf,
  projects,
  publish,
  removeWorktree,
  repoToken,
  runEvents,
  runs,
  screenshots,
  TICKET_BUDGET_USD,
  ticketSpend,
  tickets,
} from "@kanbot/shared/server";
import { baselineFailures } from "@kanbot/shared";
import { and, count, eq } from "drizzle-orm";
import { buildContext } from "./context";
import { redact, redactText } from "./runtime/redact";
import { record } from "./runtime/replay";
import type { AgentRuntime, RuntimeEvent, RuntimeResult } from "./runtime/types";
import { keepCurrent, pullDefaultBranch, pushAndOpenPr, recordRebase } from "./ship";
import {
  changedSince,
  checkAfterRun,
  ensureWorktree,
  snapshot,
  WORKTREE_COLUMNS,
} from "./worktree";
import { commitAs, runChecks, openEnv } from "./commands";
import { startApp } from "./qa-app";
import { containerBash, projectImage, pullImage, removeContainers } from "./docker";
import { finish, outcomeOf, type Outcome } from "./finish";
import { PAUSED_ERROR } from "./queue";
import type { Run } from "./results";
import { stallDetector } from "./stall";

/** Bundled plugins (§8); the worker runs with apps/worker as cwd, like agentsDir(). */
const pluginsDir = () => resolve(process.env.KANBOT_PLUGINS_DIR ?? "../../plugins");

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

  // The ticket's budget (§14): what its earlier runs cost is gone; Retry after raising it in project Settings.
  const ticketCap = project.settings?.ticketBudgetUsd ?? TICKET_BUDGET_USD;
  // Archie's retro in Done is exempt: a merged ticket must not show as failed because it was costly.
  const ticketLeft =
    run.columnSlug === "done" ? Infinity : ticketCap - (await ticketSpend(db, ticket.id));
  if (ticketLeft < 0.01)
    return finish(db, run.id, {
      state: "budget_exceeded",
      error: `Ticket budget reached: $${(ticketCap - ticketLeft).toFixed(2)} of $${ticketCap.toFixed(2)}. Raise it in project Settings, then Retry.`,
    });

  // The daily cap (§14) and the ticket's budget can leave less than the agent's own budget.
  const ticketCapped = ticketLeft < Math.min(run.budgetUsd ?? Infinity, agent.maxBudgetUsd);
  const dayCapped = !ticketCapped && run.budgetUsd != null && run.budgetUsd < agent.maxBudgetUsd;
  if (ticketCapped) {
    agent = { ...agent, maxBudgetUsd: ticketLeft };
    // The day's reserve (spendToday) counts runs.budget_usd: release what this run can't spend.
    await db.update(runs).set({ budgetUsd: ticketLeft }).where(eq(runs.id, run.id));
  } else if (dayCapped) agent = { ...agent, maxBudgetUsd: run.budgetUsd! };

  // KANBOT_RECORD=1 saves each real run as a replay script (§8 recorded runs).
  const recording = process.env.KANBOT_RECORD === "1";
  const recorded: RuntimeEvent[] = [];
  const stall = new AbortController();
  const checkStall = stallDetector(agent.editScope !== "none", (why) => stall.abort(why));
  let seq = 0;
  let testCommand: string | undefined;
  let sessionId: string | undefined;
  // The project's env var values (§10), redacted from everything this run stores; set before the agent starts.
  let secrets: string[] = [];
  const emit = async (e: RuntimeEvent) => {
    const n = ++seq;
    if (recording) recorded.push(e);
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
    checkStall(e, testCommand);
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
    // Plan B reads the clone and new branches start from it: both should see what merged on GitHub.
    if (project.repoPath && project.githubOwner && project.githubRepo)
      await pullDefaultBranch(db, {
        githubOwner: project.githubOwner,
        githubRepo: project.githubRepo,
        defaultBranch: project.defaultBranch,
        repoPath: project.repoPath,
      });
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
      // FR-48: the next run starts from the PR branch's head on GitHub, the owner's pushes included.
      const gh =
        project.githubRepo && project.githubOwner
          ? { githubOwner: project.githubOwner, githubRepo: project.githubRepo }
          : null;
      // FR-51: then onto the default branch (just brought up to GitHub's), so the run builds on what merged.
      const { pushedSha, conflict } = await keepCurrent(
        db,
        gh,
        !!ticket.prNumber,
        wt,
        project.defaultBranch,
      );
      if (pushedSha)
        await db.transaction((tx) =>
          recordRebase(tx, ticket, project.defaultBranch, pushedSha, agentActor(run.agentSlug)),
        );
      if (conflict)
        return finish(db, run.id, {
          state: "awaiting_input",
          error: `Rebasing onto ${conflict.onto} hit conflicts in ${conflict.files.join(", ")}`,
          conflict,
        });
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
        // No activity row or event: the drawer shows them with the test report, which the run's end publishes.
        saveScreenshot: async (name, png) => {
          await db.insert(screenshots).values({ ticketId: ticket.id, runId: run.id, name, png });
        },
        // Project commands the agent runs go to the project's image (§7).
        bash: (c) => commit(c) ?? container?.(c) ?? null,
      },
      emit,
    );
    if (recording && scenario !== "default")
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
  if (ticketCapped && outcome.state === "budget_exceeded")
    outcome.error = `Ticket budget reached: this run could spend only $${ticketLeft.toFixed(2)} of the $${ticketCap.toFixed(2)} ticket budget. Raise it in project Settings, then Retry.`;
  else if (dayCapped && outcome.state === "budget_exceeded")
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
      if (outcome.state === "succeeded") {
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

/** `{test}`-style placeholders → the project's commands; an entry naming a missing command is dropped. */
export function expandTools(tools: readonly string[], commands: ProjectConfig["commands"]) {
  return tools.flatMap((t) => {
    let missing = false as boolean; // set in the replace callback
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
