import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { columns, projects, runEvents, runs, tickets, type Db } from "@kanbot/shared/db";
import { removeWorktree } from "@kanbot/shared/repo";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { worktreesRoot } from "./worktree";

const execFileP = promisify(execFile);

/** Run logs are kept this long, except each ticket's last run (§11). */
export const RUN_EVENTS_DAYS = 90;

/**
 * The nightly disk cleanup (§8 "Disk over 90% full", M5): run logs past retention, worktrees that
 * finished tickets still hold or deleted tickets left behind, and project images Kanbot built that nothing has used for a week.
 * shortcut: the shared `kanbot-cache` package volume isn't pruned; clear it by hand (docs/deploy.md) if it grows.
 */
export async function nightlyCleanup(db: Db) {
  const events = await db.execute(sql`
    delete from ${runEvents} e using ${runs} r
    where e.run_id = r.id
      and r.created_at < now() - make_interval(days => ${RUN_EVENTS_DAYS})
      and r.id <> (select l.id from ${runs} l where l.ticket_id = r.ticket_id
                   order by l.created_at desc limit 1)`);

  // Archie's run removes a Done ticket's worktree (FR-49); this catches any he didn't reach.
  const left = await db
    .select({ id: tickets.id, path: tickets.worktreePath, repo: projects.repoPath })
    .from(tickets)
    .innerJoin(columns, eq(columns.id, tickets.columnId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(eq(columns.slug, "done"), isNotNull(tickets.worktreePath)));
  let worktrees = 0;
  for (const t of left)
    if (t.repo && (await removeWorktree(t.repo, t.path!))) {
      await db.update(tickets).set({ worktreePath: null }).where(eq(tickets.id, t.id));
      worktrees++;
    }

  // A deleted ticket's worktree: the web app deletes the ticket but, in Docker, sees the repos read-only.
  // Worktree folders are named by ticket key, so a folder with no ticket of that key is left over.
  const owned = await db
    .select({ repo: projects.repoPath, prefix: projects.keyPrefix, number: tickets.number })
    .from(projects)
    .leftJoin(tickets, eq(tickets.projectId, projects.id))
    .where(isNotNull(projects.repoPath));
  for (const repo of new Set(owned.map((o) => o.repo!))) {
    const root = worktreesRoot(repo);
    if (!existsSync(root)) continue;
    const keys = new Set(
      owned
        .filter((o) => o.repo === repo && o.number !== null)
        .map((o) => `${o.prefix}-${o.number}`),
    );
    for (const d of readdirSync(root, { withFileTypes: true }))
      if (d.isDirectory() && !keys.has(d.name) && (await removeWorktree(repo, join(root, d.name))))
        worktrees++;
  }

  // Images built from devcontainers carry the `kanbot` label (§7); an image still in use is kept.
  await execFileP("docker", [
    "image",
    "prune",
    "-af",
    "--filter",
    "label=kanbot",
    "--filter",
    "until=168h",
  ]).catch((e: Error) => console.warn(`docker image prune failed: ${e.message}`));

  return { runEvents: events.rowCount ?? 0, worktrees };
}
