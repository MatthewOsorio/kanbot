// Project settings live in the database, seeded once from project.yml (M4).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, loadProjectConfig, projectConfigOf, projects } from "@kanbot/shared/server";
import { prepareSampleRepo } from "@kanbot/shared/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { claimNext } from "../src/queue";
import { ensureWorktree } from "../src/worktree";
import { db, setup, drain, ticketNow, useTestDb } from "./helpers";

useTestDb();

describe("project settings in the database (M4)", () => {
  it("seeds from project.yml once; after that the database wins", async () => {
    const { project, repo } = await setup("bounce");
    const read = async () => {
      const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
      return projectConfigOf(db, p!);
    };
    expect((await read()).commands.test).toBe("node --test");
    // The file changes on the default branch, then the owner edits the database copy: neither the file
    // nor a second read may overwrite it.
    writeFileSync(join(repo, ".kanbot/project.yml"), "commands:\n  test: node other.js\n");
    await git(repo, ["commit", "-am", "change settings"]);
    expect((await read()).commands.test).toBe("node --test");
    await db
      .update(projects)
      .set({ commands: { test: "pnpm test" }, settings: { bounceLimit: 1, concurrency: 2 } })
      .where(eq(projects.id, project.id));
    const c = await read();
    expect(c).toMatchObject({ bounceLimit: 1, concurrency: 2, commands: { test: "pnpm test" } });
  });

  it("uses the project's bounce limit", async () => {
    const { ticket, col, move, project } = await setup("always");
    await db
      .update(projects)
      .set({ settings: { bounceLimit: 1 } })
      .where(eq(projects.id, project.id));
    await move("in_progress");
    await drain();
    const t = await ticketNow(ticket.id);
    expect(t.columnId).toBe(col("blocked").id);
    expect(t.bounceCount).toBe(1);
  });

  it("claims as many runs of one project at once as its concurrency allows", async () => {
    const { project, addTicket, move } = await setup("bounce");
    const b = await addTicket(2, "bounce", "Second");
    await move("planning", b.id);
    await db
      .update(projects)
      .set({ settings: { concurrency: 2 } })
      .where(eq(projects.id, project.id));
    await move("planning"); // restarts Plan B on the first ticket as well
    expect(await claimNext(db)).not.toBeNull();
    expect(await claimNext(db)).not.toBeNull(); // default 1 would refuse this
    expect(await claimNext(db)).toBeNull(); // the global limit of 2
  });

  it("installs again only when the lockfile changes", async () => {
    const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-lock-")), "repo"));
    const log = join(mkdtempSync(join(tmpdir(), "kanbot-lock-log-")), "installs");
    const config = await loadProjectConfig(repo, "main");
    config.commands.install = `echo x >> "${log}"`;
    const ticket = { key: "LK-1", title: "Lockfile", branchName: null };
    const installs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0);

    const { path } = await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(1);
    await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(1); // reused, nothing changed
    writeFileSync(join(path, "package-lock.json"), "{}");
    await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(2); // the lockfile appeared
    await ensureWorktree(repo, "main", ticket, config);
    expect(installs()).toBe(2);
    expect(await git(path, ["status", "--porcelain"])).not.toContain("kanbot-install");
  });
});
