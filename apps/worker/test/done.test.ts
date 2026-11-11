// Done: Archie's retro and worktree removal (FR-49, §4), against the replay runtime.
import { existsSync } from "node:fs";
import { uuidv7 } from "@kanbot/shared";
import { artifacts, git } from "@kanbot/shared/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context";
import { db, setup, drain, ticketNow, useTestDb } from "./helpers";

useTestDb();

describe("Done and Archie (FR-49, §4)", () => {
  /** Builds the ticket through the loop to QA, then moves it to Done as the owner would. */
  async function toDone(scenario: string) {
    const s = await setup(scenario);
    await s.move("in_progress");
    await drain();
    const wt = (await ticketNow(s.ticket.id)).worktreePath!;
    expect(existsSync(wt)).toBe(true);
    await s.move("done");
    return { ...s, wt };
  }

  it("removes the worktree, keeps the branch and stores Archie's retro", async () => {
    const { ticket, repo, wt, col } = await toDone("default");
    const [run] = await drain();
    expect(`${run!.agentSlug}:${run!.state}`).toBe("archie-the-archivist:succeeded");
    expect(existsSync(wt)).toBe(false);
    const t = await ticketNow(ticket.id);
    expect(t.worktreePath).toBeNull();
    expect(t.columnId).toBe(col("done").id);
    expect(t.statusFlag).toBe("none");
    expect((await git(repo, ["branch", "--list", t.branchName!])).trim()).not.toBe("");
    const retros = await db.select().from(artifacts).where(eq(artifacts.kind, "retro"));
    expect(retros.filter((a) => a.ticketId === ticket.id)).toHaveLength(1);
    // Archie's context carries the real totals and the run history.
    const prompt = await buildContext(
      db,
      { ...t, key: "X-1" },
      { id: uuidv7(), requestMd: null, columnSlug: "done" },
      { cwd: repo, defaultBranch: "main", hotspots: [] },
    );
    expect(prompt).toMatch(/^Write the retro for this finished ticket/);
    expect(prompt).toMatch(/Total cost: \$[\d.]+ over \d+ runs/);
    expect(prompt).toMatch(/sir-codes-a-lot \(in_progress\): succeeded/);
  });

  it("leaves a finished ticket in Done, flagged failed, when Archie's run fails", async () => {
    const { ticket, col } = await toDone("no-report");
    const [run] = await drain();
    expect(run!.state).toBe("failed");
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("done").id);
    expect(t.statusFlag).toBe("failed");
  });
});
