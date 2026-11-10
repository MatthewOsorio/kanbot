// The worker's checks after each run (rewritten commits, switched branches) on a real git repo.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "@kanbot/shared/server";
import { describe, expect, it } from "vitest";
import { checkAfterRun, snapshot } from "../src/worktree";
import { setup, useTestDb } from "./helpers";

useTestDb();

describe("post-run checks", () => {
  it("catch a rewritten commit and a switched branch", async () => {
    const { repo } = await setup("bounce");
    await git(repo, ["switch", "-q", "-c", "kanbot/X-1-check"]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "owner commit"]);
    const wt = { path: repo, branch: "kanbot/X-1-check" };
    const before = await snapshot(repo, "main");
    expect(await checkAfterRun(wt, "main", before, undefined)).toBeNull();

    await git(repo, ["commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"]);
    expect(await checkAfterRun(wt, "main", before, undefined)).toMatch(/rewritten/);

    // A file an earlier run left behind isn't this run's change (found in the M3 smoke run).
    writeFileSync(join(repo, "stray.txt"), "left by an earlier run");
    const later = await snapshot(repo, "main");
    expect(await checkAfterRun(wt, "main", later, () => false)).toBeNull();
    writeFileSync(join(repo, "new.txt"), "made during this run");
    expect(await checkAfterRun(wt, "main", later, () => false)).toMatch(/edit scope: new\.txt/);

    await git(repo, ["switch", "-q", "main"]);
    expect(await checkAfterRun(wt, "main", before, undefined)).toMatch(/switched to main/);
  });

  it("let the owner commit to main during a run, but catch the run's own commits landing there", async () => {
    const { repo } = await setup("bounce");
    await git(repo, ["switch", "-q", "-c", "kanbot/X-1-main"]);
    const wt = { path: repo, branch: "kanbot/X-1-main" };
    const before = await snapshot(repo, "main");
    // The owner commits to main (here without checking it out) while the agent works.
    const tree = (await git(repo, ["rev-parse", "main^{tree}"])).trim();
    const owner = (await git(repo, ["commit-tree", tree, "-p", "main", "-m", "owner work"])).trim();
    await git(repo, ["update-ref", "refs/heads/main", owner]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "agent work"]);
    expect(await checkAfterRun(wt, "main", before, undefined)).toBeNull();

    await git(repo, ["update-ref", "refs/heads/main", "HEAD"]); // the run's commit is now on main
    expect(await checkAfterRun(wt, "main", before, undefined)).toMatch(
      /reached the default branch/,
    );
  });
});
