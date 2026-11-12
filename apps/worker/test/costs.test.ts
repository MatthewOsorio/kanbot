// Agent versions on runs (FR-37) and the Agents/Costs page queries (M6 phase 3).
import { agentStats, agentVersions, costReport, loadAgent, runs } from "@kanbot/shared/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, drain, setup, useTestDb } from "./helpers";

useTestDb();

describe("agent versions (FR-37)", () => {
  it("a run stores the hash of the agent file it read, and the text is kept under it", async () => {
    const { move } = await setup("epic");
    await move("planning");
    const [run] = await drain();
    const agent = loadAgent("plan-b")!;
    expect(run!.configHash).toBe(agent.hash);
    const [v] = await db.select().from(agentVersions).where(eq(agentVersions.hash, agent.hash));
    expect(v).toMatchObject({ slug: "plan-b", text: agent.text });
  });
});

describe("agentStats and costReport", () => {
  // Runs in 2001 and under an agent slug nothing else uses, so other tests' runs don't count.
  it("sums by day, agent and ticket, and counts a bounce as a success", async () => {
    const { ticket, project } = await setup("epic");
    const at = (day: number) => new Date(2001, 0, day, 12);
    const run = (
      day: number,
      state: "succeeded" | "changes_requested" | "failed" | "cancelled",
      cost: number,
    ) => ({
      ticketId: ticket.id,
      agentSlug: "stats-test-agent",
      columnSlug: "planning",
      state,
      costUsd: cost,
      inputTokens: 1000,
      outputTokens: 100,
      createdAt: at(day),
      endedAt: at(day),
    });
    await db.delete(runs).where(eq(runs.agentSlug, "stats-test-agent")); // from an earlier test run
    await db
      .insert(runs)
      .values([
        run(1, "succeeded", 0.5),
        run(1, "changes_requested", 0.25),
        run(2, "failed", 1),
        run(2, "cancelled", 0),
      ]);

    const days = await costReport(db, "day", new Date(2001, 0, 1), new Date(2001, 0, 4));
    expect(days.map((d) => [d.label, d.costUsd, d.runs])).toEqual([
      ["2001-01-01", 0.75, 2],
      ["2001-01-02", 1, 2],
    ]);
    expect(days[0]).toMatchObject({ inputTokens: 2000, outputTokens: 200 });

    const [byAgent] = await costReport(db, "agent", new Date(2001, 0, 1), new Date(2001, 0, 4));
    expect(byAgent).toMatchObject({ label: "stats-test-agent", costUsd: 1.75, runs: 4 });

    const [byTicket] = await costReport(db, "ticket", new Date(2001, 0, 1), new Date(2001, 0, 4));
    expect(byTicket!.label).toBe(`${project.keyPrefix}-1`);
    expect(byTicket!.costUsd).toBe(1.75);

    // `to` is exclusive: the second day drops out.
    const one = await costReport(db, "day", new Date(2001, 0, 1), new Date(2001, 0, 2));
    expect(one.map((d) => d.label)).toEqual(["2001-01-01"]);

    const s = (await agentStats(db, new Date(2001, 0, 1))).find(
      (a) => a.agentSlug === "stats-test-agent",
    )!;
    // 4 runs, 3 finished on their own (the cancelled one isn't), 2 of those succeeded; the average is over the 3.
    expect(s).toMatchObject({ runs: 4, finished: 3, succeeded: 2 });
    expect(s.avgCostUsd).toBeCloseTo(1.75 / 3, 4);
  });
});
