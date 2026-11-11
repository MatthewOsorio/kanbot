// Epics: Plan B's proposed tickets (M4.5), against the replay runtime.
import { artifacts, runs, tickets } from "@kanbot/shared/server";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context";
import { db, setup, drain, ticketNow, useTestDb } from "./helpers";

useTestDb();

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
