// M6 phase 5: auto-pull from Ready (FR-25), WIP limits as its slots (FR-20), and a column that waits for approval (FR-22).
import {
  columns,
  projects,
  runs,
  ticketLinks,
  tickets,
  updateSettings,
} from "@kanbot/shared/server";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { autoPull } from "../src/queue";
import { db, drain, setup, ticketNow, useTestDb } from "./helpers";

useTestDb();

const setPaused = (paused: boolean) => db.transaction((tx) => updateSettings(tx, { paused }));

// Projects from earlier tests stay in the database: none may keep pulling into the next test.
afterEach(async () => {
  await db.update(projects).set({ settings: sql`coalesce(settings, '{}'::jsonb) - 'autoPull'` });
  await setPaused(false);
});

const autoPullOn = (id: string) =>
  db
    .update(projects)
    .set({ settings: { autoPull: true } })
    .where(eq(projects.id, id));

const countIn = async (columnId: string) =>
  (await db.select().from(tickets).where(eq(tickets.columnId, columnId))).length;

describe("auto-pull (FR-25)", () => {
  it("does nothing while it is off", async () => {
    const { ticket, addTicket, col } = await setup("bounce");
    await db
      .update(tickets)
      .set({ columnId: col("ready").id })
      .where(eq(tickets.id, ticket.id));
    await addTicket(2, "bounce", "Second");
    expect(await autoPull(db)).toBe(0);
    expect(await countIn(col("in_progress").id)).toBe(0);
  });

  it("starts the top Ready ticket by priority, up to the project's concurrency", async () => {
    const { project, ticket, addTicket, col } = await setup("bounce");
    await db
      .update(tickets)
      .set({ columnId: col("ready").id })
      .where(eq(tickets.id, ticket.id));
    const high = await addTicket(2, "bounce", "Urgent");
    await db.update(tickets).set({ priority: "P0" }).where(eq(tickets.id, high.id));
    await autoPullOn(project.id);

    expect(await autoPull(db)).toBe(1); // concurrency 1: one slot
    expect((await ticketNow(high.id)).columnId).toBe(col("in_progress").id);
    expect((await ticketNow(ticket.id)).columnId).toBe(col("ready").id);
    const queued = await db.select().from(runs).where(eq(runs.ticketId, high.id));
    expect(queued.map((r) => `${r.agentSlug}:${r.state}`)).toEqual(["sir-codes-a-lot:queued"]);
    expect(await autoPull(db)).toBe(0); // the slot is taken now
  });

  it("uses In Progress's WIP limit as the slots when it has one", async () => {
    const { project, ticket, addTicket, col } = await setup("bounce");
    await db
      .update(tickets)
      .set({ columnId: col("ready").id })
      .where(eq(tickets.id, ticket.id));
    await addTicket(2, "bounce", "Second");
    await addTicket(3, "bounce", "Third");
    await db
      .update(columns)
      .set({ wipLimit: 2 })
      .where(eq(columns.id, col("in_progress").id));
    await autoPullOn(project.id);

    expect(await autoPull(db)).toBe(2);
    expect(await autoPull(db)).toBe(0);
    expect(await countIn(col("ready").id)).toBe(1);
  });

  it("leaves blocked, overlapping and epic tickets in Ready", async () => {
    const { project, ticket, addTicket, col, move } = await setup("bounce");
    // In flight: the setup ticket, touching src/a.ts.
    await db
      .update(tickets)
      .set({ touchPaths: ["src/a.ts"] })
      .where(eq(tickets.id, ticket.id));
    await move("in_progress");
    const clash = await addTicket(2, "bounce", "Same file");
    await db
      .update(tickets)
      .set({ touchPaths: ["src/a.ts"] })
      .where(eq(tickets.id, clash.id));
    const blocked = await addTicket(3, "bounce", "Waits on the first");
    await db.insert(ticketLinks).values({
      projectId: project.id,
      fromTicketId: ticket.id,
      toTicketId: blocked.id,
      kind: "blocks",
      confirmed: true,
    });
    const epic = await addTicket(4, "bounce", "An epic");
    await db.update(tickets).set({ type: "epic" }).where(eq(tickets.id, epic.id));
    const free = await addTicket(5, "bounce", "Unrelated");
    await db
      .update(columns)
      .set({ wipLimit: 9 })
      .where(eq(columns.id, col("in_progress").id));
    await autoPullOn(project.id);

    expect(await autoPull(db)).toBe(1);
    expect((await ticketNow(free.id)).columnId).toBe(col("in_progress").id);
    for (const t of [clash, blocked, epic])
      expect((await ticketNow(t.id)).columnId).toBe(col("ready").id);
  });

  it("waits while Pause all is on", async () => {
    const { project, ticket, col } = await setup("bounce");
    await db
      .update(tickets)
      .set({ columnId: col("ready").id })
      .where(eq(tickets.id, ticket.id));
    await autoPullOn(project.id);
    await setPaused(true);
    expect(await autoPull(db)).toBe(0);
    await setPaused(false);
    expect(await autoPull(db)).toBe(1);
  });
});

describe("a column that waits for approval (FR-22)", () => {
  it("holds a passing ticket in Code Review, but a bounce still moves", async () => {
    const { ticket, col, move } = await setup("bounce");
    await move("planning");
    await drain();
    await move("ready");
    await db
      .update(columns)
      .set({ autoAdvance: false })
      .where(eq(columns.id, col("code_review").id));
    await move("in_progress");
    const done = await drain();
    // Nancy's changes_requested still bounced to In Progress; her pass then stopped the ticket.
    expect(done.map((r) => `${r.agentSlug}:${r.state}`)).toEqual([
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:changes_requested",
      "sir-codes-a-lot:succeeded",
      "nitpick-nancy:succeeded",
    ]);
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("code_review").id);
    expect(t.statusFlag).toBe("awaiting_approval");
    expect(t.bounceCount).toBe(1);
    const active = await db
      .select()
      .from(runs)
      .where(inArray(runs.state, ["queued", "running"]));
    expect(active.filter((r) => r.ticketId === ticket.id)).toEqual([]); // no QA run was queued
  });
});
