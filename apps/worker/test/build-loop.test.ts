// The M3 build loop against the replay runtime, on a real git repo (fixtures/sample-repo): no API calls.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRunStates, DEFAULT_COLUMNS, uuidv7 } from "@kanbot/shared";
import {
  acceptanceCriteria,
  activity,
  artifacts,
  cancelActiveRun,
  columns,
  comments,
  createDb,
  moveToColumnEnd,
  projects,
  runs,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/db";
import { prepareSampleRepo, TEST_DATABASE_URL } from "@kanbot/shared/db/testing";
import { git } from "@kanbot/shared/repo";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/context";
import { claimNext, executeRun } from "../src/run";
import { ReplayRuntime } from "../src/runtime/replay";
import { checkAfterRun, snapshot } from "../src/worktree";

const db = createDb(TEST_DATABASE_URL);
const runtime = new ReplayRuntime();
afterAll(() => db.$client.end());
beforeEach(async () => {
  await db
    .update(runs)
    .set({ state: "cancelled" })
    .where(inArray(runs.state, [...activeRunStates]));
});

/** A sample-repo project and a ticket in Planning, labelled with the replay scenario. */
async function setup(
  scenario: string,
  title = "Deleting an unknown todo removes the last one",
  keyPrefix = `L${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
) {
  const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-loop-")), "repo"));
  await db.delete(projects).where(eq(projects.keyPrefix, keyPrefix)); // a fixed prefix from an earlier test run
  const [p] = await db
    .insert(projects)
    .values({ name: "loop test", keyPrefix, repoPath: repo })
    .returning();
  const cols = await db
    .insert(columns)
    .values(DEFAULT_COLUMNS.map((c, i) => ({ ...c, projectId: p!.id, position: i })))
    .returning();
  const col = (slug: string) => cols.find((c) => c.slug === slug)!;
  const [t] = await db
    .insert(tickets)
    .values({
      projectId: p!.id,
      number: 1,
      title,
      type: "bug",
      columnId: col("planning").id,
      position: "a0",
      labels: [`replay:${scenario}`],
    })
    .returning();
  /** A manual move, as the move route does it (minus the overlap check, tested in the web app). */
  const move = (slug: string, id = t!.id) =>
    db.transaction(async (tx) => {
      const [now] = await tx.select().from(tickets).where(eq(tickets.id, id));
      const from = cols.find((c) => c.id === now!.columnId)!;
      await moveToColumnEnd(tx, now!, from, col(slug), { kind: "user", name: "owner" });
      await startColumnAgent(tx, p!.id, id, col(slug));
    });
  /** Another ticket in the same project (and repo), in Ready. */
  const addTicket = async (number: number, scenario: string, title: string) =>
    (
      await db
        .insert(tickets)
        .values({
          projectId: p!.id,
          number,
          title,
          type: "feature",
          columnId: col("ready").id,
          position: `a${number}`,
          labels: [`replay:${scenario}`],
        })
        .returning()
    )[0]!;
  return { project: p!, ticket: t!, repo, col, move, addTicket };
}

/** Runs queued runs until none is left (the worker's claim loop, synchronously). */
async function drain(limit = 20) {
  const done = [];
  for (let i = 0; i < limit; i++) {
    const run = await claimNext(db);
    if (!run) return done;
    await executeRun(db, runtime, run, new AbortController().signal);
    done.push((await db.select().from(runs).where(eq(runs.id, run.id)))[0]!);
  }
  throw new Error("runs never stopped");
}

const ticketNow = async (id: string) =>
  (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("build loop (M3 done criterion)", () => {
  it("goes Ready → In Progress → Review → (bounce) → In Progress → Review → QA on its own", async () => {
    const { ticket, project, repo, col, move } = await setup("bounce");
    await move("planning");
    await drain();
    expect((await ticketNow(ticket.id)).statusFlag).toBe("plan_ready");

    await move("ready");
    await move("in_progress");
    const done = await drain();
    expect(done.map((r) => `${r.agentSlug}:${r.state}`)).toEqual([
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:changes_requested",
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:succeeded",
      "testy-mctestface:succeeded",
    ]);

    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("qa").id);
    expect(t.statusFlag).toBe("awaiting_approval");
    expect(t.bounceCount).toBe(1);
    expect(t.branchName).toMatch(/^kanbot\/L\w+-1-deleting-an-unknown-todo/);
    expect(t.worktreePath).toBe(join(`${repo}.kanbot-worktrees`, `${project.keyPrefix}-1`));
    // Plan B's predicted touch set plus what the branch changed.
    expect(t.touchPaths).toEqual(expect.arrayContaining(["src/todos.ts", "test/todos.test.ts"]));

    // Real commits on the ticket branch; the default branch untouched.
    const log = await git(repo, ["log", "--format=%s", `main..${t.branchName}`]);
    expect(log.trim().split("\n")).toEqual([
      "Tests for DELETE of an unknown todo",
      "Test remove() with an unknown id",
      "Guard TodoStore.remove against unknown ids",
    ]);
    expect(await git(repo, ["log", "--format=%s", "main"])).toBe("Initial sample app\n");

    // Nancy's line comment was stored, then resolved by her approval.
    const notes = await db.select().from(comments).where(eq(comments.ticketId, ticket.id));
    expect(notes).toEqual([
      expect.objectContaining({
        authorKind: "agent",
        agentSlug: "nitpick-nancy",
        file: "src/todos.ts",
        line: 27,
        resolved: true,
      }),
    ]);
    const kinds = await db
      .select({ kind: artifacts.kind, version: artifacts.version })
      .from(artifacts)
      .where(eq(artifacts.ticketId, ticket.id))
      .orderBy(asc(artifacts.createdAt));
    expect(kinds.map((k) => `${k.kind}@${k.version}`)).toEqual([
      "plan@1",
      "review@1",
      "review@2",
      "test_report@1",
    ]);

    // Testy checked off both of the plan's criteria.
    const criteria = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticket.id));
    expect(criteria.map((c) => c.status)).toEqual(["pass", "pass"]);

    const bounce = await db
      .select()
      .from(activity)
      .where(and(eq(activity.ticketId, ticket.id), eq(activity.action, "run_finished")));
    expect(bounce.some((a) => a.data.bounce === 1)).toBe(true);
  });

  it.each(["bug", "feature", "review", "ui"])(
    "replays the recorded real-agent golden %s run to QA",
    async (slug) => {
      const { ticket, col, move } = await setup(`golden-${slug}`);
      await move("planning");
      await drain();
      await move("ready");
      await move("in_progress");
      const done = await drain();
      expect(done.map((r) => r.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
      const t = await ticketNow(ticket.id);
      expect(t.columnId).toBe(col("qa").id);
      const criteria = await db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.ticketId, ticket.id));
      expect(criteria.length).toBeGreaterThan(0);
      expect(criteria.every((c) => c.status === "pass")).toBe(true); // $criterionN mapped back to ids
    },
  );

  it("sends the ticket to Blocked once the bounce limit is used up", async () => {
    const { ticket, col, move } = await setup("always");
    await move("in_progress");
    const done = await drain();
    expect(done.filter((r) => r.agentSlug === "nitpick-nancy")).toHaveLength(4);
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("blocked").id);
    expect(t.bounceCount).toBe(3);
    const [last] = await db
      .select()
      .from(activity)
      .where(and(eq(activity.ticketId, ticket.id), eq(activity.action, "run_finished")))
      .orderBy(asc(activity.createdAt))
      .then((rows) => rows.slice(-1));
    expect(last!.data.reason).toMatch(/Bounce limit/);
  });

  it("fails a QA run that changed files outside the test globs, keeping its commit", async () => {
    const { ticket, repo, col, move } = await setup("outside");
    await move("qa");
    const [run] = await drain();
    expect(run!.state).toBe("failed");
    expect(run!.error).toMatch(/outside this agent's edit scope: src\/server\.ts/);
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("blocked").id);
    expect(await git(repo, ["log", "-1", "--format=%s", t.branchName!])).toBe("Touch the server\n");
  });

  it("stops a run that repeats the same tool call three times", async () => {
    const { ticket, col, move } = await setup("stall");
    await move("in_progress");
    const [run] = await drain();
    expect(run!.state).toBe("awaiting_input");
    expect(run!.error).toMatch(/same Bash call 3 times/);
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("blocked").id);
    expect(t.statusFlag).toBe("needs_input");
  });

  it("bounces a QA failure back to In Progress, then passes", async () => {
    const { ticket, col, move } = await setup("qa-fail");
    await move("planning");
    await drain();
    await move("ready");
    await move("in_progress");
    const done = await drain();
    expect(done.map((r) => `${r.agentSlug}:${r.state}`)).toEqual([
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:succeeded",
      "testy-mctestface:failed",
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:succeeded",
      "testy-mctestface:succeeded",
    ]);
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("qa").id);
    expect(t.statusFlag).toBe("awaiting_approval");
    expect(t.bounceCount).toBe(1);
    const criteria = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticket.id));
    expect(criteria.map((c) => c.status)).toEqual(["pass", "pass"]);
  });

  it("turns Nancy's approval with a blocking cross-ticket risk into a bounce, noted on both tickets", async () => {
    const { ticket, col, move, addTicket } = await setup("risk", undefined, "RISK");
    const other = await addTicket(2, "default", "Rewrite TodoStore.remove");
    await move("in_progress");
    const done = await drain();
    expect(done.map((r) => `${r.agentSlug}:${r.state}`)).toEqual([
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:changes_requested",
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:succeeded",
      "testy-mctestface:succeeded",
    ]);
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("qa").id);
    expect(t.bounceCount).toBe(1);
    const notes = await db.select().from(comments).where(eq(comments.ticketId, other.id));
    expect(notes).toEqual([
      expect.objectContaining({
        agentSlug: "nitpick-nancy",
        bodyMd: expect.stringMatching(/^RISK-1: \*\*Cross-ticket risk \(blocking, conflict\)/),
      }),
    ]);
  });

  it("builds two tickets in one repo side by side without mixing their branches", async () => {
    const { project, ticket, repo, col, move, addTicket } = await setup("bounce");
    const other = await addTicket(2, "golden-bug", "Second ticket in flight");
    await move("in_progress");
    await move("in_progress", other.id);
    await drain();
    const [a, b] = [await ticketNow(ticket.id), await ticketNow(other.id)];
    expect([a.columnId, b.columnId]).toEqual([col("qa").id, col("qa").id]);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    const logOf = async (branch: string) =>
      (await git(repo, ["log", "--format=%s", `main..${branch}`])).trim().split("\n");
    const [la, lb] = [await logOf(a.branchName!), await logOf(b.branchName!)];
    expect(la).toContain("Guard TodoStore.remove against unknown ids");
    expect(lb).not.toContain("Guard TodoStore.remove against unknown ids");
    expect(la.filter((s) => lb.includes(s))).toEqual([]);

    // Nancy reviewing one ticket is shown the other one in flight.
    const prompt = await buildContext(
      db,
      { ...b, key: `${project.keyPrefix}-2` },
      { id: uuidv7(), requestMd: null, columnSlug: "code_review" },
      { cwd: b.worktreePath, defaultBranch: "main", hotspots: [] },
    );
    expect(prompt).toContain("<in_flight_tickets>");
    expect(prompt).toContain(`${project.keyPrefix}-1`);
  });

  it("recreates a deleted worktree from its branch, keeping the commits", async () => {
    const { ticket, move } = await setup("bounce");
    await move("in_progress");
    const first = (await claimNext(db))!;
    await executeRun(db, runtime, first, new AbortController().signal);
    const t = await ticketNow(ticket.id);
    rmSync(t.worktreePath!, { recursive: true, force: true });
    await drain();
    expect((await ticketNow(ticket.id)).worktreePath).toBe(t.worktreePath);
    const log = await git(t.worktreePath!, ["log", "--format=%s", "main..HEAD"]);
    expect(log).toContain("Guard TodoStore.remove against unknown ids");
    expect(log).toContain("Tests for DELETE of an unknown todo");
  });

  it("cancelling a build mid-run leaves the worktree on its branch, and a new run picks it up", async () => {
    const { project, ticket, col, move } = await setup("cancel");
    await move("in_progress");
    const run = (await claimNext(db))!;
    const ctl = new AbortController();
    const running = executeRun(db, runtime, run, ctl.signal);
    await new Promise((r) => setTimeout(r, 1_000));
    await db.transaction((tx) => cancelActiveRun(tx, project.id, ticket.id));
    ctl.abort();
    await running;
    expect((await db.select().from(runs).where(eq(runs.id, run.id)))[0]!.state).toBe("cancelled");
    const t = await ticketNow(ticket.id);
    expect(await git(t.worktreePath!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      `${t.branchName}\n`,
    );
    await db.transaction((tx) => startColumnAgent(tx, project.id, ticket.id, col("in_progress")));
    await drain();
    expect((await ticketNow(ticket.id)).columnId).toBe(col("qa").id);
  });

  it("doesn't call it a stall when the agent edits between identical test runs", async () => {
    const { move } = await setup("retest");
    await move("qa");
    const [run] = await drain();
    expect(run!.state).toBe("succeeded"); // stopped as a stall in the M3 golden run
  });

  it("refuses to build without a linked repo", async () => {
    const { ticket, project, move } = await setup("bounce");
    await db.update(projects).set({ repoPath: null }).where(eq(projects.id, project.id));
    await move("in_progress");
    const [run] = await drain();
    expect(run!.error).toMatch(/Link a local repo/);
    expect((await ticketNow(ticket.id)).worktreePath).toBeNull();
  });
});

describe("post-run checks", () => {
  it("catch a rewritten commit and a switched branch", async () => {
    const { repo } = await setup("bounce");
    await git(repo, ["switch", "-q", "-c", "kanbot/X-1-check"]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "owner commit"]);
    const wt = { path: repo, branch: "kanbot/X-1-check" };
    const before = await snapshot(repo, "main");
    expect(await checkAfterRun(wt, "main", before, undefined)).toBeNull();

    await git(repo, ["commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"]);
    expect(await checkAfterRun(wt, "main", before, undefined)).toMatch(/rewritten/);

    // A file an earlier run left behind isn't this run's change (found in the M3 smoke run).
    writeFileSync(join(repo, "stray.txt"), "left by an earlier run");
    const later = await snapshot(repo, "main");
    expect(await checkAfterRun(wt, "main", later, () => false)).toBeNull();
    writeFileSync(join(repo, "new.txt"), "made during this run");
    expect(await checkAfterRun(wt, "main", later, () => false)).toMatch(/edit scope: new\.txt/);

    await git(repo, ["switch", "-q", "main"]);
    expect(await checkAfterRun(wt, "main", before, undefined)).toMatch(/switched to main/);
  });

  it("let the owner commit to main during a run, but catch the run's own commits landing there", async () => {
    const { repo } = await setup("bounce");
    await git(repo, ["switch", "-q", "-c", "kanbot/X-1-main"]);
    const wt = { path: repo, branch: "kanbot/X-1-main" };
    const before = await snapshot(repo, "main");
    // The owner commits to main (here without checking it out) while the agent works.
    const tree = (await git(repo, ["rev-parse", "main^{tree}"])).trim();
    const owner = (await git(repo, ["commit-tree", tree, "-p", "main", "-m", "owner work"])).trim();
    await git(repo, ["update-ref", "refs/heads/main", owner]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "agent work"]);
    expect(await checkAfterRun(wt, "main", before, undefined)).toBeNull();

    await git(repo, ["update-ref", "refs/heads/main", "HEAD"]); // the run's commit is now on main
    expect(await checkAfterRun(wt, "main", before, undefined)).toMatch(
      /reached the default branch/,
    );
  });
});
