// The orchestrator against the replay runtime (requirements §8): no API calls, real Postgres (kanbot_test).
import { activeRunStates, DEFAULT_COLUMNS, uuidv7 } from "@kanbot/shared";
import {
  acceptanceCriteria,
  artifacts,
  cancelActiveRun,
  comments,
  columns,
  createDb,
  projects,
  runEvents,
  runs,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/db";
import { TEST_DATABASE_URL } from "@kanbot/shared/db/testing";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/context";
import { afterPrevious, claimNext, executeRun, recoverInterrupted } from "../src/run";
import { ReplayRuntime } from "../src/runtime/replay";
import type { AgentRuntime } from "../src/runtime/types";

const db = createDb(TEST_DATABASE_URL);
const runtime = new ReplayRuntime();
afterAll(() => db.$client.end());

// claimNext is global: leftovers from an aborted e2e run must not be claimed by these tests.
beforeEach(async () => {
  await db
    .update(runs)
    .set({ state: "cancelled" })
    .where(inArray(runs.state, [...activeRunStates]));
});

/** A project with a ticket sitting in Planning and Plan B queued for it, as a manual move leaves it. */
async function plannedTicket(scenario?: string) {
  const [p] = await db
    .insert(projects)
    .values({
      name: "worker test",
      keyPrefix: `W${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    })
    .returning();
  const cols = await db
    .insert(columns)
    .values(DEFAULT_COLUMNS.map((c, i) => ({ ...c, projectId: p!.id, position: i })))
    .returning();
  const planning = cols.find((c) => c.slug === "planning")!;
  const [t] = await db
    .insert(tickets)
    .values({
      projectId: p!.id,
      number: 1,
      title: "Add a filter",
      columnId: planning.id,
      position: "a0",
      labels: scenario ? [`replay:${scenario}`] : [],
    })
    .returning();
  await db
    .insert(acceptanceCriteria)
    .values({ ticketId: t!.id, text: "Owner's own item", position: 0 });
  await queue(t!.id);
  return { project: p!, ticket: t!, cols };
}

const queue = (ticketId: string) =>
  db.transaction(async (tx) => {
    const [t] = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
    const col = (await tx.select().from(columns).where(eq(columns.id, t!.columnId)))[0]!;
    return startColumnAgent(tx, t!.projectId, t!.id, col);
  });

async function claimAndRun(signal = new AbortController().signal) {
  const run = await claimNext(db);
  expect(run).not.toBeNull();
  await executeRun(db, runtime, run!, signal);
  return (await db.select().from(runs).where(eq(runs.id, run!.id)))[0]!;
}

const ticketNow = async (id: string) =>
  (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const columnSlug = (cols: { id: string; slug: string }[], id: string) =>
  cols.find((c) => c.id === id)!.slug;

describe("Plan B run (M2 done criterion)", () => {
  it("produces a plan artifact, agent criteria and a plan_ready flag", async () => {
    const { ticket, cols } = await plannedTicket();
    const run = await claimAndRun();
    expect(run).toMatchObject({
      state: "succeeded",
      verdict: "success",
      costUsd: 0.12,
      inputTokens: 5200,
    });

    const t = await ticketNow(ticket.id);
    expect(columnSlug(cols, t.columnId)).toBe("planning");
    expect(t.statusFlag).toBe("plan_ready");

    const [plan] = await db.select().from(artifacts).where(eq(artifacts.ticketId, ticket.id));
    expect(plan).toMatchObject({ kind: "plan", version: 1, runId: run.id });
    expect(plan!.contentMd).toContain("## Problem");

    const criteria = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticket.id))
      .orderBy(asc(acceptanceCriteria.position));
    expect(criteria.map((c) => c.source)).toEqual(["user", "agent", "agent"]);

    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.seq));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0]!.payload).toMatchObject({ subtype: "init" });
  });

  it("a re-plan adds plan v2, keeps v1 and replaces only the agent's criteria", async () => {
    const { ticket } = await plannedTicket();
    await claimAndRun();
    await queue(ticket.id);
    await claimAndRun();
    const plans = await db.select().from(artifacts).where(eq(artifacts.ticketId, ticket.id));
    expect(plans.map((p) => p.version).sort()).toEqual([1, 2]);
    const criteria = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.ticketId, ticket.id));
    expect(criteria.filter((c) => c.source === "agent")).toHaveLength(2);
    expect(criteria.filter((c) => c.source === "user")).toHaveLength(1);
  });

  it("only a 'Request changes' run gets a <revision_request>; comments stay background", async () => {
    const { ticket } = await plannedTicket();
    const first = await claimAndRun();
    await db.insert(comments).values({ ticketId: ticket.id, bodyMd: "FYI: staging is down" });
    const t = { ...ticket, key: "W-1" };
    const noRepo = { cwd: null, defaultBranch: "main", hotspots: [] };
    const plan = { columnSlug: "planning" };
    const plain = await buildContext(db, t, { ...plan, id: first.id, requestMd: null }, noRepo);
    expect(plain).not.toContain("<revision_request>");
    expect(plain).toContain("FYI: staging is down");
    const revise = await buildContext(
      db,
      t,
      { ...plan, id: uuidv7(), requestMd: "Use SQLite" },
      noRepo,
    );
    expect(revise).toMatch(/^Revise this ticket's plan/);
    expect(revise).toContain("<revision_request>\nUse SQLite\n</revision_request>");
  });
});

describe("run outcomes", () => {
  it.each([
    ["no-report", "failed", "blocked", "failed", /without calling report_result/],
    ["malformed", "failed", "blocked", "failed", /Invalid report_result/],
    ["budget", "budget_exceeded", "blocked", "failed", /maxBudgetUsd/],
    ["needs-input", "awaiting_input", "blocked", "needs_input", null],
    ["outage", "interrupted", "planning", "failed", /overloaded/],
    ["rate-limit", "succeeded", "planning", "plan_ready", null],
  ] as const)(
    "%s → run %s, ticket in %s flagged %s",
    async (scenario, state, column, flag, error) => {
      const { ticket, cols } = await plannedTicket(scenario);
      const run = await claimAndRun();
      expect(run.state).toBe(state);
      if (error) expect(run.error).toMatch(error);
      const t = await ticketNow(ticket.id);
      expect(columnSlug(cols, t.columnId)).toBe(column);
      expect(t.statusFlag).toBe(flag);
    },
  );

  it("records the SDK's API retries in the live log", async () => {
    await plannedTicket("rate-limit");
    const run = await claimAndRun();
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
    expect(events.filter((e) => e.payload.subtype === "api_retry")).toHaveLength(2);
  });

  it("cancelling mid-run stops it; the cancelled state is never overwritten", async () => {
    const { project, ticket } = await plannedTicket("slow");
    const run = (await claimNext(db))!;
    const ac = new AbortController();
    const done = executeRun(db, runtime, run, ac.signal);
    await new Promise((r) => setTimeout(r, 800));
    await db.transaction((tx) => cancelActiveRun(tx, project.id, ticket.id));
    ac.abort(); // what the worker does when it hears run.finished
    await done;
    const [after] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(after!.state).toBe("cancelled");
    expect(await db.select().from(artifacts).where(eq(artifacts.ticketId, ticket.id))).toHaveLength(
      0,
    );
    expect((await ticketNow(ticket.id)).statusFlag).toBe("none");
  });

  it("fails a run that can't be recorded instead of leaving it running, and keeps NULs out of the log", async () => {
    const { ticket } = await plannedTicket();
    // A NUL in the summary makes finish()'s insert throw (Postgres text rejects 0x00).
    const nul: AgentRuntime = {
      run: async (_req, emit) => {
        await emit({ type: "tool_result", payload: { content: "bin\0ary" } });
        const report = { verdict: "success", summary: "done\0", artifacts: [] };
        return { report, stop: "completed", costUsd: 0, inputTokens: 0, outputTokens: 0 };
      },
    };
    const run = (await claimNext(db))!;
    await executeRun(db, nul, run, new AbortController().signal);
    const [after] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(after!.state).toBe("failed");
    expect(after!.error).toMatch(/failed to record/);
    const [logged] = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
    expect(logged!.payload.content).toBe("binary");
    expect((await ticketNow(ticket.id)).statusFlag).toBe("failed");
  });

  it("marks runs left running by a dead worker as interrupted", async () => {
    const { ticket } = await plannedTicket();
    const run = (await claimNext(db))!; // claimed, then the worker "dies"
    expect(await recoverInterrupted(db)).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(after!.state).toBe("interrupted");
    expect((await ticketNow(ticket.id)).statusFlag).toBe("failed");
  });
});

describe("claiming", () => {
  it("runs at most one run per project at a time and never claims a run twice", async () => {
    const { project, cols } = await plannedTicket();
    const planning = cols.find((c) => c.slug === "planning")!;
    const [second] = await db
      .insert(tickets)
      .values({
        projectId: project.id,
        number: 2,
        title: "Second",
        columnId: planning.id,
        position: "a1",
      })
      .returning();
    await queue(second!.id);

    const first = await claimNext(db);
    expect(first).not.toBeNull();
    expect(await claimNext(db)).toBeNull(); // same project is busy
    await executeRun(db, runtime, first!, new AbortController().signal);
    const next = await claimNext(db);
    expect(next?.ticketId).toBe(second!.id);
    expect(next?.id).not.toBe(first!.id);
    await executeRun(db, runtime, next!, new AbortController().signal);
    const states = await db
      .select({ state: runs.state })
      .from(runs)
      .where(and(inArray(runs.id, [first!.id, next!.id])));
    expect(states.map((s) => s.state)).toEqual(["succeeded", "succeeded"]);
  });
});

describe("afterPrevious", () => {
  it("starts a ticket's next run only once its previous one has stopped, even if that one threw", async () => {
    const order: string[] = [];
    const stopping = afterPrevious("t1", async () => {
      await new Promise((r) => setTimeout(r, 50)); // a cancelled agent still shutting down
      order.push("old stopped");
      throw new Error("aborted");
    });
    const next = afterPrevious("t1", async () => void order.push("next started"));
    const other = afterPrevious("t2", async () => void order.push("other ticket started"));
    await Promise.allSettled([stopping, next, other]);
    expect(order).toEqual(["other ticket started", "old stopped", "next started"]);
    await expect(stopping).rejects.toThrow("aborted"); // the caller still sees the failure
  });
});
