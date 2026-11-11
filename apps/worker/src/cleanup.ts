import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  columns,
  type Db,
  projectConfigOf,
  projects,
  removeWorktree,
  runEvents,
  runs,
  tickets,
} from "@kanbot/shared/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { devcontainerImage } from "./docker";
import { worktreesRoot } from "./worktree";

const execFileP = promisify(execFile);

/**
 * Images built from devcontainers carry the `kanbot` label (§7). Each project keeps the one its default
 * branch builds now; older ones go (`until` filters on build time, so it would delete a current image too).
 * One a running container still uses is refused by docker and stays.
 */
async function pruneImages(db: Db) {
  const keep = new Set<string>();
  for (const p of await db.select().from(projects).where(isNotNull(projects.repoPath))) {
    const { image, dockerfile } = await projectConfigOf(db, p);
    if (image || !dockerfile) continue;
    keep.add((await devcontainerImage(p.repoPath!, p.defaultBranch, dockerfile, p.keyPrefix)).tag);
  }
  const listed = await execFileP("docker", [
    "images",
    "--filter",
    "label=kanbot",
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  for (const tag of listed.stdout.split("\n").map((t) => t.trim()))
    if (tag && !tag.includes("<none>") && !keep.has(tag))
      await execFileP("docker", ["rmi", tag]).catch(() => {}); // in use
  await execFileP("docker", ["image", "prune", "-f", "--filter", "label=kanbot"]); // untagged leftovers
}

/** Run logs are kept this long, except each ticket's last run (§11). */
const RUN_EVENTS_DAYS = 90;

/**
 * The nightly disk cleanup (§8 "Disk over 90% full", M5): run logs past retention, worktrees that
 * finished tickets still hold or deleted tickets left behind, and project images Kanbot built that are no longer current.
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
      // "_baseline" (onboarding) isn't a ticket key: it is in use, or onboarding removes it itself.
      if (
        d.isDirectory() &&
        !d.name.startsWith("_") &&
        !keys.has(d.name) &&
        (await removeWorktree(repo, join(root, d.name)))
      )
        worktrees++;
  }

  await pruneImages(db).catch((e: Error) =>
    console.warn(`docker image prune failed: ${e.message}`),
  );

  return { runEvents: events.rowCount ?? 0, worktrees };
}
