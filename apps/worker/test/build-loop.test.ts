// The M3 build loop against the replay runtime, on a real git repo (fixtures/sample-repo): no API calls.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  projectConfigOf,
  projects,
  runs,
  startColumnAgent,
  ticketLinks,
  tickets,
} from "@kanbot/shared/db";
import { prepareSampleRepo, TEST_DATABASE_URL } from "@kanbot/shared/db/testing";
import { git, loadProjectConfig } from "@kanbot/shared/repo";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/context";
import { claimNext, executeRun } from "../src/run";
import { ReplayRuntime } from "../src/runtime/replay";
import { checkAfterRun, ensureWorktree, projectImage, snapshot } from "../src/worktree";

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
      await cancelActiveRun(tx, p!.id, id); // e.g. Rubber Duckworth, queued when the ticket hit Blocked
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
    // The bounce resumed Sir Codes-a-Lot's session instead of starting cold (FR-35).
    expect(done[0]!.sessionId).toBeTruthy();
    expect(done[2]!.resumeSessionId).toBe(done[0]!.sessionId);
    expect(done[3]!.resumeSessionId).toBeNull(); // Nancy re-reviews with fresh eyes
    // Each run records only the files it changed (the Diff tab's "Changed by").
    expect(done[0]!.filesChanged).toEqual(["src/todos.ts"]);
    expect(done[1]!.filesChanged).toEqual([]);
    expect(done[4]!.filesChanged.length).toBeGreaterThan(0);

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
      .then((rows) => rows.filter((r) => r.data.agent === "nitpick-nancy").slice(-1));
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

  it("starts the app for a QA run, tells Testy where it is, and stops it after", async () => {
    const { ticket, move } = await setup("default");
    await move("qa");
    let seen: { url?: string; status?: number; prompt?: string } = {};
    const probe: typeof runtime = {
      run: async (req, emit) => {
        seen = {
          url: req.appUrl,
          status: (await fetch(req.appUrl!)).status,
          prompt: req.prompt,
        };
        return runtime.run(req, emit);
      },
    };
    const run = (await claimNext(db))!;
    await executeRun(db, probe, run, new AbortController().signal);
    expect(seen.status).toBe(200);
    expect(seen.prompt).toContain(`App: running at ${seen.url}`);
    expect(seen.prompt).toContain("Test command: node --test");
    await expect(fetch(seen.url!)).rejects.toThrow(); // stopped
    expect((await ticketNow(ticket.id)).statusFlag).not.toBe("failed");
  });

  it("tells Testy when no app is configured", async () => {
    const { project, move } = await setup("default");
    await projectConfigOf(db, project); // seed from project.yml, then drop the start command
    await db
      .update(projects)
      .set({ commands: { test: "node --test" } })
      .where(eq(projects.id, project.id));
    await move("qa");
    let req: Parameters<typeof runtime.run>[0] | undefined;
    const run = (await claimNext(db))!;
    await executeRun(
      db,
      { run: async (r, emit) => ((req = r), runtime.run(r, emit)) },
      run,
      new AbortController().signal,
    );
    expect(req!.appUrl).toBeUndefined();
    expect(req!.prompt).toContain("App: not configured");
  });

  it("stops a run that repeats the same tool call three times", async () => {
    const { ticket, col, move } = await setup("stall");
    await move("in_progress");
    const [run] = await drain();
    expect(run!.state).toBe("awaiting_input");
    expect(run!.error).toMatch(/same Bash call 3 times/);
    expect(run!.sessionId).toBe("replay-sir-codes-a-lot-stall.1"); // kept for Resume, though it never reported
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("blocked").id);
    expect(t.statusFlag).toBe("needs_input");
  });

  it("stops a run that makes 25 calls with no file change and no test run", async () => {
    const { move } = await setup("no-progress");
    await move("in_progress");
    const [run] = await drain();
    expect(run!.state).toBe("awaiting_input");
    expect(run!.error).toMatch(/25 tool calls with no file change and no test run/);
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

  it("sends a branch whose tests fail back to Sir Codes-a-Lot before review (checks gate)", async () => {
    const { ticket, col, move } = await setup("checks-fail");
    await move("in_progress");
    const done = await drain();
    expect(done.map((r) => `${r.agentSlug}:${r.state}`)).toEqual([
      "sir-codes-a-lot:changes_requested",
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:succeeded",
      "testy-mctestface:succeeded",
    ]);
    expect(done[0]!.error).toBe("Kanbot checks: `node --test` failed");
    expect(done[1]!.resumeSessionId).toBe(done[0]!.sessionId); // he picks up where he left off
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("qa").id);
    expect(t.bounceCount).toBe(1);
    const [report] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.ticketId, ticket.id), eq(artifacts.kind, "test_report")))
      .orderBy(asc(artifacts.version));
    expect(report!.title).toBe("Kanbot checks: `node --test` failed");
    expect(report!.contentMd).toMatch(/remove deletes the todo/);
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

  it("proposes the other ticket as a blocker when Nancy reports a blocking risk", async () => {
    const { ticket, move, addTicket } = await setup("risk", undefined, "RISK");
    const other = await addTicket(2, "default", "Rewrite TodoStore.remove");
    await move("in_progress");
    await drain();
    const links = await db.select().from(ticketLinks).where(eq(ticketLinks.toTicketId, ticket.id));
    expect(links).toEqual([
      expect.objectContaining({
        fromTicketId: other.id,
        kind: "blocks",
        confirmed: false,
        source: "agent",
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

  it("removes the worktree when install fails, so the next run installs again", async () => {
    const { project, repo, move } = await setup("bounce");
    // project.yml only seeds; the owner's copy lives in the database (Settings).
    const setInstall = (cmd: string) =>
      db
        .update(projects)
        .set({ commands: { install: cmd, test: "node --test" }, testGlobs: ["test/**"] })
        .where(eq(projects.id, project.id));
    const runOne = async () => {
      const run = (await claimNext(db))!;
      await executeRun(db, runtime, run, new AbortController().signal);
      return (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
    };
    const wt = join(`${repo}.kanbot-worktrees`, `${project.keyPrefix}-1`);

    await setInstall("node -e process.exit(1)");
    await move("in_progress");
    expect((await runOne()).error).toMatch(/Install failed/);
    expect(existsSync(wt)).toBe(false);

    await setInstall("node --version");
    await move("in_progress");
    expect((await runOne()).error ?? "").not.toMatch(/Install failed/);
    expect(existsSync(wt)).toBe(true);
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

// Needs Docker (CI's ubuntu runner has it); skipped where none is running.
const IMAGE = "node:24-alpine";
const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8" });
const hasDocker = (() => {
  try {
    return !!docker(["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    return false;
  }
})();

describe.skipIf(!hasDocker)("project commands in the project's image (M5, §7)", () => {
  const useImage = (id: string) =>
    db.update(projects).set({ image: IMAGE }).where(eq(projects.id, id));
  const leftovers = () => docker(["ps", "-aq", "--filter", "label=kanbot"]).trim();

  it("runs the checks gate in the image", async () => {
    const { project, move } = await setup("checks-fail");
    await projectConfigOf(db, project); // seed from project.yml first, so the image isn't overwritten
    await useImage(project.id);
    await move("in_progress");
    const done = await drain();
    expect(done[0]!.error).toBe("Kanbot checks: `node --test` failed");
    const [report] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, done[0]!.id), eq(artifacts.kind, "test_report")));
    expect(report!.contentMd).toMatch(/remove deletes the todo/); // the test output, from the container
    expect(done.at(-1)!.state).toBe("succeeded");
    expect(leftovers()).toBe("");
  }, 120_000);

  it("starts the QA app in the image on 127.0.0.1 and removes it after", async () => {
    const { project, move } = await setup("default");
    await projectConfigOf(db, project);
    await useImage(project.id);
    await move("qa");
    let seen: { url?: string; status?: number; running?: string } = {};
    const probe: typeof runtime = {
      run: async (req, emit) => {
        seen = {
          url: req.appUrl,
          status: (await fetch(req.appUrl!)).status,
          running: leftovers(),
        };
        return runtime.run(req, emit);
      },
    };
    await executeRun(db, probe, (await claimNext(db))!, new AbortController().signal);
    expect(seen.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.status).toBe(200);
    expect(seen.running).not.toBe(""); // it really was a container
    expect(leftovers()).toBe("");
  }, 120_000);

  it("builds the image from the devcontainer's Dockerfile on the default branch, once", async () => {
    const { project, repo, move } = await setup("default");
    // The owner's repo has a devcontainer that builds (paths relative to .devcontainer/, context the repo).
    mkdirSync(join(repo, ".devcontainer"));
    writeFileSync(
      join(repo, ".devcontainer", "devcontainer.json"),
      `{\n  // dev image\n  "build": { "dockerfile": "Dockerfile", "context": ".." },\n}\n`,
    );
    writeFileSync(
      join(repo, ".devcontainer", "Dockerfile"),
      `FROM ${IMAGE}\nCOPY package.json /kanbot-built/\n`,
    );
    await git(repo, ["add", ".devcontainer"]);
    await git(repo, ["commit", "-q", "-m", "devcontainer"]);
    const config = await projectConfigOf(db, project);
    expect(config.dockerfile).toEqual({ file: ".devcontainer/Dockerfile", context: "." });

    await move("qa");
    let image = "";
    const probe: typeof runtime = {
      run: async (req, emit) => {
        image = docker(["ps", "--filter", "label=kanbot", "--format", "{{.Image}}"]).trim();
        expect((await fetch(req.appUrl!)).status).toBe(200);
        return runtime.run(req, emit);
      },
    };
    await executeRun(db, probe, (await claimNext(db))!, new AbortController().signal);
    expect(image).toMatch(new RegExp(`^kanbot-${project.keyPrefix.toLowerCase()}:[0-9a-f]{12}$`));
    // The COPY came from the default branch's tree (the build context).
    expect(docker(["run", "--rm", image, "ls", "/kanbot-built"]).trim()).toBe("package.json");
    // Same default branch, same tag: no rebuild.
    expect(await projectImage(repo, "main", config, project.keyPrefix)).toBe(image);
    // The owner's Image wins over the devcontainer.
    expect(await projectImage(repo, "main", { ...config, image: IMAGE }, project.keyPrefix)).toBe(
      IMAGE,
    );
    docker(["rmi", image]);
    // A Dockerfile that doesn't build fails with the build's output.
    writeFileSync(join(repo, ".devcontainer", "Dockerfile"), `FROM ${IMAGE}\nRUN exit 7\n`);
    await git(repo, ["commit", "-q", "-am", "broken"]);
    await expect(projectImage(repo, "main", config, project.keyPrefix)).rejects.toThrow(
      /Building the devcontainer image kanbot-.* failed:[\s\S]*exit 7/,
    );
  }, 300_000);
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

describe("Done and Archie (FR-49, §4)", () => {
  /** Builds the ticket through the loop to QA, then moves it to Done as the owner would. */
  async function toDone(scenario: string) {
    const s = await setup(scenario);
    await s.move("in_progress");
    await drain();
    const wt = (await ticketNow(s.ticket.id)).worktreePath!;
    expect(existsSync(wt)).toBe(true);
    await s.move("done");
    return { ...s, wt };
  }

  it("removes the worktree, keeps the branch and stores Archie's retro", async () => {
    const { ticket, repo, wt, col } = await toDone("default");
    const [run] = await drain();
    expect(`${run!.agentSlug}:${run!.state}`).toBe("archie-the-archivist:succeeded");
    expect(existsSync(wt)).toBe(false);
    const t = await ticketNow(ticket.id);
    expect(t.worktreePath).toBeNull();
    expect(t.columnId).toBe(col("done").id);
    expect(t.statusFlag).toBe("none");
    expect((await git(repo, ["branch", "--list", t.branchName!])).trim()).not.toBe("");
    const retros = await db.select().from(artifacts).where(eq(artifacts.kind, "retro"));
    expect(retros.filter((a) => a.ticketId === ticket.id)).toHaveLength(1);
    // Archie's context carries the real totals and the run history.
    const prompt = await buildContext(
      db,
      { ...t, key: "X-1" },
      { id: uuidv7(), requestMd: null, columnSlug: "done" },
      { cwd: repo, defaultBranch: "main", hotspots: [] },
    );
    expect(prompt).toMatch(/^Write the retro for this finished ticket/);
    expect(prompt).toMatch(/Total cost: \$[\d.]+ over \d+ runs/);
    expect(prompt).toMatch(/sir-codes-a-lot \(in_progress\): succeeded/);
  });

  it("leaves a finished ticket in Done, flagged failed, when Archie's run fails", async () => {
    const { ticket, col } = await toDone("no-report");
    const [run] = await drain();
    expect(run!.state).toBe("failed");
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("done").id);
    expect(t.statusFlag).toBe("failed");
  });
});

describe("project settings in the database (M4)", () => {
  it("seeds from project.yml once; after that the database wins", async () => {
    const { project, repo } = await setup("bounce");
    const read = async () => {
      const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
      return projectConfigOf(db, p!);
    };
    expect((await read()).commands.test).toBe("node --test");
    // The file changes on the default branch, then the owner edits the database copy: neither the file
    // nor a second read may overwrite it.
    writeFileSync(join(repo, ".kanbot/project.yml"), "commands:\n  test: node other.js\n");
    await git(repo, ["commit", "-am", "change settings"]);
    expect((await read()).commands.test).toBe("node --test");
    await db
      .update(projects)
      .set({ commands: { test: "pnpm test" }, settings: { bounceLimit: 1, concurrency: 2 } })
      .where(eq(projects.id, project.id));
    const c = await read();
    expect(c).toMatchObject({ bounceLimit: 1, concurrency: 2, commands: { test: "pnpm test" } });
  });

  it("uses the project's bounce limit", async () => {
    const { ticket, col, move, project } = await setup("always");
    await db
      .update(projects)
      .set({ settings: { bounceLimit: 1 } })
      .where(eq(projects.id, project.id));
    await move("in_progress");
    await drain();
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("blocked").id);
    expect(t.bounceCount).toBe(1);
  });

  it("claims as many runs of one project at once as its concurrency allows", async () => {
    const { project, addTicket, move } = await setup("bounce");
    const b = await addTicket(2, "bounce", "Second");
    await move("planning", b.id);
    await db
      .update(projects)
      .set({ settings: { concurrency: 2 } })
      .where(eq(projects.id, project.id));
    await move("planning"); // restarts Plan B on the first ticket as well
    expect(await claimNext(db)).not.toBeNull();
    expect(await claimNext(db)).not.toBeNull(); // default 1 would refuse this
    expect(await claimNext(db)).toBeNull(); // the global limit of 2
  });

  it("installs again only when the lockfile changes", async () => {
    const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-lock-")), "repo"));
    const log = join(mkdtempSync(join(tmpdir(), "kanbot-lock-log-")), "installs");
    const config = await loadProjectConfig(repo, "main");
    config.commands.install = `echo x >> "${log}"`;
    const ticket = { key: "LK-1", title: "Lockfile", branchName: null };
    const installs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0);

    const { path } = await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(1);
    await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(1); // reused, nothing changed
    writeFileSync(join(path, "package-lock.json"), "{}");
    await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(2); // the lockfile appeared
    await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(2);
    expect(await git(path, ["status", "--porcelain"])).not.toContain("kanbot-install");
  });
});

describe("epics (M4.5)", () => {
  it("stores Plan B's proposed tickets on an epic's plan, cleaned", async () => {
    const { ticket, move } = await setup("epic", "Due dates for todos");
    await db.update(tickets).set({ type: "epic" }).where(eq(tickets.id, ticket.id));
    await move("planning");
    const [run] = await drain();
    expect(run!.state).toBe("succeeded");
    expect((await ticketNow(ticket.id)).statusFlag).toBe("plan_ready");
    const [plan] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.ticketId, ticket.id), eq(artifacts.kind, "plan")));
    const data = plan!.data as {
      proposedTickets: { ref: string; blockedBy: string[] }[];
      accepted: object;
    };
    // The duplicate t2 is dropped, and t2's forward reference to t3 with it (no cycles).
    expect(data.proposedTickets.map((p) => [p.ref, p.blockedBy])).toEqual([
      ["t1", []],
      ["t2", ["t1"]],
      ["t3", ["t2"]],
    ]);
    expect(data.accepted).toEqual({});
  });

  it("tells Plan B to split an epic", async () => {
    const { ticket, project } = await setup("epic");
    const [run] = await db
      .insert(runs)
      .values({ ticketId: ticket.id, agentSlug: "plan-b", columnSlug: "planning" })
      .returning();
    const prompt = (t: string) =>
      buildContext(db, { ...ticket, type: t, key: `${project.keyPrefix}-1` }, run!, {
        cwd: null,
        defaultBranch: "main",
        hotspots: [],
      });
    expect(await prompt("epic")).toMatch(/^Plan this epic: split it into tickets/);
    expect(await prompt("feature")).toMatch(/^Plan this ticket\./);
    await db.update(runs).set({ state: "cancelled" }).where(eq(runs.id, run!.id));
  });
});
