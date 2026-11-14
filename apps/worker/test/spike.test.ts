// Dr. Rabbit Hole (UC-10) against the replay runtime: no API calls.
import { artifacts, tickets } from "@kanbot/shared/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, drain, setup, ticketNow, useTestDb } from "./helpers";

useTestDb();

describe("Dr. Rabbit Hole", () => {
  it("researches a spike in Planning instead of Plan B, and offers its follow-up tickets", async () => {
    const { ticket, move } = await setup("default", "Which SQLite library should the store use?");
    await db.update(tickets).set({ type: "spike" }).where(eq(tickets.id, ticket.id));
    await move("planning");
    const done = await drain();
    expect(done.map((r) => `${r.agentSlug}:${r.state}`)).toEqual(["dr-rabbit-hole:succeeded"]);
    expect((await ticketNow(ticket.id)).statusFlag).toBe("plan_ready");
    const found = await db.select().from(artifacts).where(eq(artifacts.ticketId, ticket.id));
    expect(found.map((a) => a.kind)).toEqual(["research"]);
    expect(found[0]!.data).toMatchObject({ proposedTickets: [{ ref: "t1" }], accepted: {} });
  });

  it("leaves Plan B to every other ticket type", async () => {
    const { move } = await setup("default");
    await move("planning");
    expect((await drain()).map((r) => r.agentSlug)).toEqual(["plan-b"]);
  });
});
