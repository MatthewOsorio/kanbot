// The M3 build loop against the replay runtime, on a real git repo (fixtures/sample-repo): no API calls.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@kanbot/shared";
import {
  acceptanceCriteria,
  activity,
  artifacts,
  cancelActiveRun,
  comments,
  git,
  projectConfigOf,
  projects,
  QaSetupError,
  runEvents,
  runs,
  screenshots,
  startColumnAgent,
  ticketLinks,
} from "@kanbot/shared/server";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context";
import { claimNext } from "../src/queue";
import { executeRun } from "../src/run";
import { projectImage } from "../src/docker";
import { startApp } from "../src/qa-app";
import { db, runtime, setup, drain, ticketNow, useTestDb } from "./helpers";

useTestDb();

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

  it("stores QA's browser screenshots with the run, and keeps their bytes out of the Live log (§4)", async () => {
    const { ticket, move } = await setup("qa-browser");
    await db.insert(acceptanceCriteria).values({
      ticketId: ticket.id,
      text: "Add is visible without scrolling on phones",
      position: 0,
    });
    await move("qa");
    const [run] = await drain();
    expect(run!.state).toBe("succeeded");
    const shots = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.ticketId, ticket.id))
      .orderBy(asc(screenshots.createdAt));
    expect(shots.map((s) => [s.name, s.runId])).toEqual([
      ["Add at 375px, after adding Buy milk", run!.id],
      ["Home at 1280px", run!.id],
    ]);
    expect(shots[0]!.png.subarray(1, 4).toString()).toBe("PNG");
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, run!.id));
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/iVBOR/); // PNG base64
    const [criterion] = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticket.id));
    expect(criterion!.status).toBe("pass");
  });

  it("holds a reviewed ticket in Code Review when there's no start command for QA (§4)", async () => {
    const { ticket, project, col, move } = await setup("default");
    await projectConfigOf(db, project); // seed from project.yml, then drop the start command
    await db
      .update(projects)
      .set({ commands: { test: "node --test" } })
      .where(eq(projects.id, project.id));
    await expect(move("qa")).rejects.toBeInstanceOf(QaSetupError);
    await move("code_review");
    const done = await drain();
    expect(done.map((r) => `${r.agentSlug}:${r.state}`)).toEqual(["nitpick-nancy:succeeded"]);
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("code_review").id);
    expect(t.statusFlag).toBe("needs_input");
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

  it("doesn't call it a stall when QA reads the page again after clicking or typing", async () => {
    const { ticket, move } = await setup("qa-browser-reads");
    await db
      .insert(acceptanceCriteria)
      .values({ ticketId: ticket.id, text: "The heading counts todos left", position: 0 });
    await move("qa");
    const [run] = await drain();
    expect(run!.error).toBeNull(); // stopped as a stall in the M5 eval (the same browser_read 3 times)
    expect(run!.state).toBe("succeeded");
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
if (process.env.CI && !hasDocker) throw new Error("CI needs Docker");

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
        image = docker(["ps", "--filter", "label=kanbot", "--format", "{{.Image}}"])
          .split("\n")
          .filter((i) => i && !i.startsWith("alpine/socat"))
          .join("\n"); // the app's, not its forwarder's
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

  // QA's app runs as the owner would run it (§4): any port, any host, PORT read or not.
  const server = (listen: string) =>
    `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${listen})"`;
  it.each([
    ["ignores PORT and listens on localhost only (Vite)", IMAGE, server("5173,'127.0.0.1'")],
    ["listens on IPv6 localhost only (Vite on newer Node)", IMAGE, server("5173,'::1'")],
    ["reads PORT", IMAGE, server("process.env.PORT")],
    ["has a fixed port on all interfaces (python)", "python:3.12-alpine", "python -m http.server"],
  ])(
    "reaches an app that %s",
    async (_, image, command) => {
      const dir = mkdtempSync(join(tmpdir(), "kanbot-app-"));
      try {
        const app = await startApp(command, dir, image);
        if ("error" in app) throw new Error(app.error);
        expect((await fetch(app.url)).status).toBe(200);
        await app.stop();
        expect(leftovers()).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
