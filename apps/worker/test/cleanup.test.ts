// Nightly cleanup (M5) against the replay runtime and a real git repo: no API calls.
import { existsSync } from "node:fs";
import { git, projectConfigOf, runEvents, runs, tickets } from "@kanbot/shared/server";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nightlyCleanup } from "../src/cleanup";
import { ensureWorktree } from "../src/worktree";
import { db, setup, ticketNow, useTestDb } from "./helpers";

useTestDb();

describe("nightly cleanup (M5)", () => {
  it("prunes old run logs except each ticket's last run, and worktrees left in Done", async () => {
    const { project, ticket, repo, col } = await setup("default");
    const old = new Date(Date.now() - 100 * 24 * 3600_000);
    const [first, last] = await db
      .insert(runs)
      .values(
        [0, 1].map((i) => ({
          ticketId: ticket.id,
          agentSlug: "plan-b",
          columnSlug: "planning",
          state: "succeeded" as const,
          createdAt: new Date(old.getTime() + i * 1000),
        })),
      )
      .returning();
    await db
      .insert(runEvents)
      .values(
        [first!, last!].map((r) => ({ runId: r.id, seq: 1, type: "system" as const, payload: {} })),
      );
    const wt = await ensureWorktree(
      repo,
      "main",
      { key: `${project.keyPrefix}-1`, title: ticket.title, branchName: null },
      await projectConfigOf(db, project),
    );
    await db
      .update(tickets)
      .set({ columnId: col("done").id, worktreePath: wt.path, branchName: wt.branch })
      .where(eq(tickets.id, ticket.id));
    // A deleted ticket's worktree (no ticket has key -99).
    const orphan = await ensureWorktree(
      repo,
      "main",
      { key: `${project.keyPrefix}-99`, title: "gone", branchName: null },
      await projectConfigOf(db, project),
    );

    await nightlyCleanup(db);
    expect(existsSync(orphan.path)).toBe(false);
    const left = await db
      .select({ runId: runEvents.runId })
      .from(runEvents)
      .where(inArray(runEvents.runId, [first!.id, last!.id]));
    expect(left.map((e) => e.runId)).toEqual([last!.id]);
    expect(existsSync(wt.path)).toBe(false);
    expect((await ticketNow(ticket.id)).worktreePath).toBeNull();
    expect(await git(repo, ["branch", "--list", wt.branch])).toContain(wt.branch); // branch kept
  });
});
