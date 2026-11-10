// The GitHub watcher (§10, FR-46, FR-47, FR-48): a ticket shipped through the stub, then CI, reviews, merges and
// closes set on the stub, one watchGitHub tick at a time.
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRunStates, DEFAULT_COLUMNS } from "@kanbot/shared";
import {
  activity,
  artifacts,
  columns,
  comments,
  createDb,
  git,
  projects,
  runs,
  settings,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/server";
import {
  type GitHubStub,
  prepareSampleRepo,
  startGitHubStub,
  TEST_DATABASE_URL,
} from "@kanbot/shared/testing";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNext } from "../src/queue";
import { executeRun } from "../src/run";
import { ReplayRuntime } from "../src/runtime/replay";
import { watchGitHub } from "../src/watch";
import { connectTestApp } from "./github-app";

const db = createDb(TEST_DATABASE_URL);
const runtime = new ReplayRuntime();
let tmp: string;
let origin: string;
let stub: GitHubStub;
const env = { ...process.env };
const WORKFLOWS = ["ci.yml"];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kanbot-watch-"));
  origin = await prepareSampleRepo(join(tmp, "origin"));
  stub = await startGitHubStub({
    owner: "octo",
    repo: "sample",
    cloneUrl: origin,
    workflows: WORKFLOWS,
  });
  await connectTestApp(db, stub.url);
});
beforeEach(async () => {
  await db
    .update(runs)
    .set({ state: "cancelled" })
    .where(inArray(runs.state, [...activeRunStates]));
  // Other tests' shipped tickets point at PRs this stub never opened: only this test's ticket is watched.
  await db.update(tickets).set({ prNumber: null }).where(isNotNull(tickets.prNumber));
  stub.setWorkflows(WORKFLOWS);
});
afterAll(async () => {
  process.env = env;
  await db.update(settings).set({ githubApp: null });
  await stub.close();
  await db.$client.end();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

let n = 0;
/** A GitHub project and a ticket that Captain Ship-It shipped: in Ship, flagged pr_open, with an open PR. */
async function shipped(bounceLimit?: number) {
  const checkout = join(tmp, `checkout-${++n}`);
  await git(tmp, ["clone", "-q", "--", origin, checkout]);
  const [p] = await db
    .insert(projects)
    .values({
      name: "watch test",
      keyPrefix: `W${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      repoPath: checkout,
      githubOwner: "octo",
      githubRepo: "sample",
      onboarding: { step: "ready" as const, state: "waiting" as const },
      ...(bounceLimit !== undefined && { settings: { bounceLimit } }),
    })
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
      title: "Report unknown todos",
      columnId: col("ship").id,
      position: "a0",
      labels: ["replay:default"],
    })
    .returning();
  await db.transaction((tx) => startColumnAgent(tx, p!.id, t!.id, col("ship")));
  const run = await runOne();
  expect(`${run.agentSlug}:${run.state}`).toBe("captain-ship-it:succeeded");
  const now = await ticketNow(t!.id);
  expect(now).toMatchObject({ statusFlag: "pr_open", ciState: "pending" });
  return { project: p!, ticket: now, col, checkout };
}

async function runOne() {
  const run = await claimNext(db);
  if (!run) throw new Error("nothing queued");
  await executeRun(db, runtime, run, new AbortController().signal);
  return (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
}
const ticketNow = async (id: string) =>
  (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const columnOf = async (id: string) =>
  (
    await db
      .select({ slug: columns.slug })
      .from(tickets)
      .innerJoin(columns, eq(columns.id, tickets.columnId))
      .where(eq(tickets.id, id))
  )[0]!.slug;
const queued = async (id: string) =>
  (
    await db
      .select({ agent: runs.agentSlug })
      .from(runs)
      .where(and(eq(runs.ticketId, id), inArray(runs.state, [...activeRunStates])))
  ).map((r) => r.agent);
const actions = async (id: string) =>
  (await db.select().from(activity).where(eq(activity.ticketId, id))).map((a) => a.action);
const check = (id: number, conclusion: string | null, name = "ci") => ({
  id,
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
});

describe("CI (FR-46)", () => {
  it("waits while CI runs, then moves to PR Review when it passes", async () => {
    const { ticket } = await shipped();
    stub.setChecks(ticket.headSha!, [check(1, null)]);
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("ship");
    expect((await ticketNow(ticket.id)).ciState).toBe("pending");

    stub.setChecks(ticket.headSha!, [check(1, "success"), check(2, "skipped", "lint")]);
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("pr_review");
    expect(await ticketNow(ticket.id)).toMatchObject({ ciState: "passing", statusFlag: "none" });
    expect(await queued(ticket.id)).toEqual([]); // PR Review is the owner's gate
  });

  it("moves straight to PR Review when the repo has no workflows", async () => {
    const { ticket } = await shipped();
    stub.setWorkflows([]);
    stub.setChecks(ticket.headSha!, []); // a commit shipped within the same second as another test's shares its sha
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("pr_review");
    expect((await ticketNow(ticket.id)).ciState).toBe("none");
  });

  it("bounces red CI to In Progress with the log, counting a bounce", async () => {
    const { ticket } = await shipped();
    stub.setChecks(ticket.headSha!, [check(77, "failure", "test")]);
    stub.setJobLog(77, "lots\nof\nlog\nnot ok 3 - removes a todo");
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("in_progress");
    expect(await ticketNow(ticket.id)).toMatchObject({ ciState: "failing", bounceCount: 1 });
    expect(await queued(ticket.id)).toEqual(["sir-codes-a-lot"]);
    const [report] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.ticketId, ticket.id), eq(artifacts.kind, "test_report")))
      .orderBy(desc(artifacts.version));
    expect(report?.title).toBe("CI failed: test");
    expect(report?.contentMd).toContain("not ok 3 - removes a todo");
  });

  it("blocks at the bounce limit instead", async () => {
    const { ticket } = await shipped(0);
    stub.setChecks(ticket.headSha!, [check(1, "failure")]);
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("blocked");
    expect(await queued(ticket.id)).toEqual(["rubber-duckworth"]); // as after any bounce limit (§8)
  });
});

describe("the PR Review gate (FR-47)", () => {
  async function inReview() {
    const s = await shipped();
    stub.setChecks(s.ticket.headSha!, [check(1, "success")]);
    await watchGitHub(db);
    expect(await columnOf(s.ticket.id)).toBe("pr_review");
    return s;
  }

  it("imports requested changes once and bounces without counting it", async () => {
    const { ticket } = await inReview();
    stub.addReview(
      ticket.prNumber!,
      { id: 500, user: { login: "octo" }, state: "CHANGES_REQUESTED", body: "Rename it." },
      [{ path: "src/todo.js", line: 12, body: "Use a Map here." }],
    );
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("in_progress");
    expect(await ticketNow(ticket.id)).toMatchObject({
      reviewState: "changes_requested",
      lastReviewId: 500,
      bounceCount: 0,
    });
    const imported = await db.select().from(comments).where(eq(comments.ticketId, ticket.id));
    // One insert: the rows share created_at and their ids aren't monotonic within a millisecond, so any order.
    expect(imported.map((c) => [c.authorKind, c.file, c.line]).sort()).toEqual([
      ["user", null, null],
      ["user", "src/todo.js", 12],
    ]);
    expect(imported[0]!.bodyMd).toContain("Rename it.");
    expect(await actions(ticket.id)).toContain("review_imported");
  });

  it("shows an approval and waits for the merge", async () => {
    const { ticket } = await inReview();
    stub.addReview(ticket.prNumber!, {
      id: 600,
      user: { login: "octo" },
      state: "APPROVED",
      body: "",
    });
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("pr_review");
    expect((await ticketNow(ticket.id)).reviewState).toBe("approved");
  });

  it("moves a merged PR to Done and starts Archie", async () => {
    const { ticket } = await inReview();
    stub.setPr(ticket.prNumber!, { merged: true });
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("done");
    expect(await queued(ticket.id)).toEqual(["archie-the-archivist"]);
    expect(await actions(ticket.id)).toContain("pr_merged");
  });

  it("returns a closed PR's ticket to Backlog without its worktree, keeping the branch", async () => {
    const { ticket, checkout } = await inReview();
    stub.setPr(ticket.prNumber!, { closed: true });
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("backlog");
    const t = await ticketNow(ticket.id);
    expect(t.worktreePath).toBeNull();
    expect(existsSync(ticket.worktreePath!)).toBe(false);
    expect((await git(checkout, ["rev-parse", "--verify", t.branchName!])).trim()).toBeTruthy();
    expect(await queued(ticket.id)).toEqual([]);
  });

  it("leaves alone a ticket the owner moved", async () => {
    const { ticket, col } = await inReview();
    await db
      .update(tickets)
      .set({ columnId: col("qa").id })
      .where(eq(tickets.id, ticket.id));
    stub.setPr(ticket.prNumber!, { merged: true });
    await watchGitHub(db);
    expect(await columnOf(ticket.id)).toBe("qa");
  });
});

describe("the owner's pushes (FR-48)", () => {
  it("starts the next ticket's branch from what merged on GitHub", async () => {
    const { project, col, checkout } = await shipped();
    // A merge on GitHub: the default branch moves on the origin (which has main checked out), not in Kanbot's clone.
    await writeFile(join(origin, `MERGED-${n}.md`), "merged\n");
    await git(origin, ["add", `MERGED-${n}.md`]);
    await git(origin, ["-c", "user.name=o", "-c", "user.email=o@x", "commit", "-qm", "Merged PR"]);
    const [next] = await db
      .insert(tickets)
      .values({
        projectId: project.id,
        number: 2,
        title: "Next ticket",
        columnId: col("in_progress").id,
        position: "a1",
        labels: ["replay:default"],
      })
      .returning();
    await db.transaction((tx) => startColumnAgent(tx, project.id, next!.id, col("in_progress")));
    await runOne();
    const t = await ticketNow(next!.id);
    expect(existsSync(join(t.worktreePath!, `MERGED-${n}.md`))).toBe(true);
    expect(existsSync(join(checkout, `MERGED-${n}.md`))).toBe(true);
  });

  it("records the new head, and the next run starts from it", async () => {
    const { ticket, col } = await shipped();
    // The owner pushes a commit to the PR's branch from their own clone.
    const mine = join(tmp, `owner-${n}`);
    await git(tmp, ["clone", "-q", "-b", ticket.branchName!, "--", origin, mine]);
    await writeFile(join(mine, "OWNER.md"), "mine\n");
    await git(mine, ["add", "OWNER.md"]);
    await git(mine, ["-c", "user.name=o", "-c", "user.email=o@x", "commit", "-qm", "Owner fix"]);
    await git(mine, ["push", "-q", "origin", ticket.branchName!]);
    const ownerSha = (await git(mine, ["rev-parse", "HEAD"])).trim();

    await watchGitHub(db);
    expect(await ticketNow(ticket.id)).toMatchObject({ headSha: ownerSha, ciState: "pending" });
    expect(await actions(ticket.id)).toContain("pushed");

    // Ship again: the worktree fast-forwards to the owner's commit, and the push keeps it.
    await db
      .update(tickets)
      .set({ labels: ["replay:reship"] })
      .where(eq(tickets.id, ticket.id));
    await db.transaction((tx) => startColumnAgent(tx, ticket.projectId, ticket.id, col("ship")));
    const run = await runOne();
    expect(run.state).toBe("succeeded");
    const t = await ticketNow(ticket.id);
    await git(origin, ["merge-base", "--is-ancestor", ownerSha, t.headSha!]); // throws if not
    expect(existsSync(join(t.worktreePath!, "OWNER.md"))).toBe(true);
  });
});
