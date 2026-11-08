// Ship (§4, FR-42, FR-43): Captain Ship-It's run, then the worker's checks, push and PR, against the GitHub stub.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRunStates, DEFAULT_COLUMNS } from "@kanbot/shared";
import {
  activity,
  artifacts,
  columns,
  createDb,
  projects,
  runs,
  settings,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/db";
import { prepareSampleRepo, TEST_DATABASE_URL } from "@kanbot/shared/db/testing";
import { saveGitHubApp } from "@kanbot/shared/github";
import { startGitHubStub, type GitHubStub } from "@kanbot/shared/github-stub";
import { git } from "@kanbot/shared/repo";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNext, executeRun } from "../src/run";
import { ReplayRuntime } from "../src/runtime/replay";
import { commitAs } from "../src/worktree";

const db = createDb(TEST_DATABASE_URL);
const runtime = new ReplayRuntime();
let tmp: string;
let origin: string;
let stub: GitHubStub;
const env = { ...process.env };

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kanbot-ship-"));
  origin = await prepareSampleRepo(join(tmp, "origin"));
  stub = await startGitHubStub({ owner: "octo", repo: "sample", cloneUrl: origin });
  process.env.KANBOT_GITHUB_API = stub.url;
  process.env.KANBOT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  await db.update(settings).set({ githubApp: null });
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  await saveGitHubApp(db, {
    id: 1,
    slug: "kanbot-test",
    clientId: "c",
    clientSecret: "s",
    webhookSecret: null,
    pem,
    ownerId: 1,
    ownerLogin: "octo",
  });
});
beforeEach(async () => {
  await db
    .update(runs)
    .set({ state: "cancelled" })
    .where(inArray(runs.state, [...activeRunStates]));
});
afterAll(async () => {
  process.env = env;
  await db.update(settings).set({ githubApp: null });
  await stub.close();
  await db.$client.end();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

let n = 0;
/** A GitHub project (cloned from `origin`, setup done) and a ticket moved into Ship with a replay scenario. */
async function shipTicket(scenario = "default", github = true) {
  const checkout = join(tmp, `checkout-${++n}`);
  await git(tmp, ["clone", "-q", "--", origin, checkout]);
  const [p] = await db
    .insert(projects)
    .values({
      name: "ship test",
      keyPrefix: `S${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      repoPath: checkout,
      ...(github && {
        githubOwner: "octo",
        githubRepo: "sample",
        onboarding: { step: "ready" as const, state: "waiting" as const },
      }),
    })
    .returning();
  const cols = await db
    .insert(columns)
    .values(DEFAULT_COLUMNS.map((c, i) => ({ ...c, projectId: p!.id, position: i })))
    .returning();
  const ship = cols.find((c) => c.slug === "ship")!;
  const [t] = await db
    .insert(tickets)
    .values({
      projectId: p!.id,
      number: 1,
      title: "Report unknown todos",
      columnId: ship.id,
      position: "a0",
      labels: [`replay:${scenario}`],
    })
    .returning();
  const started = await db.transaction((tx) => startColumnAgent(tx, p!.id, t!.id, ship));
  return { project: p!, ticket: t!, started, ship, checkout };
}

async function runOne() {
  const run = await claimNext(db);
  if (!run) throw new Error("nothing queued");
  await executeRun(db, runtime, run, new AbortController().signal);
  return (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
}
const ticketNow = async (id: string) =>
  (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("Ship (FR-43)", () => {
  it("pushes the branch and opens the PR with Ship-It's description", async () => {
    const { ticket, project } = await shipTicket();
    const run = await runOne();
    expect(`${run.agentSlug}:${run.state}`).toBe("captain-ship-it:succeeded");
    const t = await ticketNow(ticket.id);
    expect(t.statusFlag).toBe("pr_open");
    expect(t.prNumber).toBe(stub.calls.pulls.length);
    expect(t.prUrl).toBe(`https://github.com/octo/sample/pull/${t.prNumber}`);
    // The pushed head is on the origin, and it carries Ship-It's changelog commit.
    const key = `${project.keyPrefix}-1`;
    expect((await git(origin, ["rev-parse", t.branchName!])).trim()).toBe(t.headSha);
    expect(await git(origin, ["show", `${t.branchName}:CHANGELOG.md`])).toMatch(/Unreleased/);
    const body = stub.calls.pulls.at(-1) as Record<string, string>;
    expect(body).toMatchObject({
      title: `${key}: Report unknown todos`,
      head: t.branchName,
      base: "main",
    });
    expect(body.body).toContain("Replay PR description.");
    expect(body.body).toContain(`Kanbot ticket ${key}`);
    const [desc] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.ticketId, ticket.id), eq(artifacts.kind, "pr_description")));
    expect(desc).toBeDefined();
    const [opened] = await db
      .select()
      .from(activity)
      .where(and(eq(activity.ticketId, ticket.id), eq(activity.action, "pr_opened")));
    expect(opened?.data).toMatchObject({ number: t.prNumber, updated: false });
  });

  it("updates the same PR when the ticket ships again", async () => {
    const { ticket, project, ship } = await shipTicket();
    await runOne();
    const first = await ticketNow(ticket.id);
    const opened = stub.calls.pulls.length;
    await db.transaction((tx) => startColumnAgent(tx, project.id, ticket.id, ship));
    // A re-ship finds its changelog entry already there and changes nothing.
    await db
      .update(tickets)
      .set({ labels: ["replay:reship"] })
      .where(eq(tickets.id, ticket.id));
    const run = await runOne();
    expect(run.state).toBe("succeeded");
    expect(stub.calls.pulls.length).toBe(opened);
    expect(stub.calls.pullUpdates.at(-1)).toMatchObject({ number: first.prNumber });
    expect((await ticketNow(ticket.id)).prNumber).toBe(first.prNumber);
  });

  it("fails the run when the push is refused, and opens no PR", async () => {
    const { ticket, checkout } = await shipTicket();
    await git(checkout, ["remote", "set-url", "origin", join(tmp, "nowhere")]);
    const opened = stub.calls.pulls.length;
    const run = await runOne();
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/Couldn't push or open the PR/);
    expect(stub.calls.pulls.length).toBe(opened);
    expect((await ticketNow(ticket.id)).prNumber).toBeNull();
  });

  it("refuses Ship-It's edits outside Markdown and docs/", async () => {
    const { ticket } = await shipTicket("edits-code");
    const run = await runOne();
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/src\/shipped\.ts/);
    expect((await ticketNow(ticket.id)).prNumber).toBeNull();
  });

  it("keeps Ship a gate on a local-folder project", async () => {
    const { started } = await shipTicket("default", false);
    expect(started).toBeNull();
  });
});

describe("commit trailers and the bot identity (FR-42)", () => {
  const bot = { name: "kanbot-test[bot]", email: "4242+kanbot-test[bot]@users.noreply.github.com" };
  it("rewrites only git commit", () => {
    const rewrite = commitAs("sir-codes-a-lot", "KB-7", bot);
    expect(rewrite("git status")).toBeNull();
    expect(rewrite("node --test")).toBeNull();
    expect(rewrite('git commit -m "Fix it"')).toBe(
      `git -c 'user.name=kanbot-test[bot]' -c 'user.email=4242+kanbot-test[bot]@users.noreply.github.com' commit --trailer 'Kanbot-Agent: sir-codes-a-lot' --trailer 'Kanbot-Ticket: KB-7' -m "Fix it"`,
    );
    expect(commitAs("a", "K-1")("git commit -m x")).toBe(
      `git commit --trailer 'Kanbot-Agent: a' --trailer 'Kanbot-Ticket: K-1' -m x`,
    );
  });

  it("commits with the trailers and the bot as author through a real shell", async () => {
    const repo = await prepareSampleRepo(join(tmp, "trailers"));
    const cmd = commitAs("sir-codes-a-lot", "KB-7", bot)('git commit --allow-empty -m "Fix it"')!;
    const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
    execFileSync(shell, ["-c", cmd], { cwd: repo });
    const log = await git(repo, ["log", "-1", "--format=%an <%ae>%n%B"]);
    expect(log).toContain(`${bot.name} <${bot.email}>`);
    expect(log).toContain("Kanbot-Agent: sir-codes-a-lot");
    expect(log).toContain("Kanbot-Ticket: KB-7");
  });
});
