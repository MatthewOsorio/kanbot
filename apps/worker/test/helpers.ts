// Shared setup for the worker's replay-runtime tests: a test database, a sample-repo project and the claim loop.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRunStates, DEFAULT_COLUMNS } from "@kanbot/shared";
import {
  cancelActiveRun,
  columns,
  createDb,
  moveToColumnEnd,
  projects,
  runs,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/server";
import { prepareSampleRepo, TEST_DATABASE_URL } from "@kanbot/shared/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { claimNext } from "../src/queue";
import { executeRun } from "../src/run";
import { ReplayRuntime } from "../src/runtime/replay";

export const db = createDb(TEST_DATABASE_URL);
export const runtime = new ReplayRuntime();

/**
 * Call once at the top of a test file: ends the pool after the file, and cancels runs another file
 * left active (claimNext is global, so a leftover run must not be claimed by this file's tests).
 */
export function useTestDb() {
  afterAll(() => db.$client.end());
  beforeEach(async () => {
    await db
      .update(runs)
      .set({ state: "cancelled" })
      .where(inArray(runs.state, [...activeRunStates]));
  });
}

/** A sample-repo project and a ticket in Planning, labelled with the replay scenario. */
export async function setup(
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
export async function drain(limit = 20) {
  const done = [];
  for (let i = 0; i < limit; i++) {
    const run = await claimNext(db);
    if (!run) return done;
    await executeRun(db, runtime, run, new AbortController().signal);
    done.push((await db.select().from(runs).where(eq(runs.id, run.id)))[0]!);
  }
  throw new Error("runs never stopped");
}

export const ticketNow = async (id: string) =>
  (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
