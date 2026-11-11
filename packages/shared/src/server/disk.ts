import { statfs } from "node:fs/promises";
import { isNotNull } from "drizzle-orm";
import { projects, type Db } from "./db";

/** §8: over this share of a disk used, no new runs start. */
export const DISK_LIMIT = 0.9;

/**
 * The first project repo path whose filesystem is fuller than `limit` (worktrees sit next to their repo), or null.
 * shortcut: only project repo filesystems; Postgres's and Docker's storage aren't checked.
 */
export async function diskFull(db: Pick<Db, "select">, limit = DISK_LIMIT) {
  const rows = await db
    .select({ path: projects.repoPath })
    .from(projects)
    .where(isNotNull(projects.repoPath));
  for (const path of new Set(rows.map((r) => r.path!))) {
    const s = await statfs(path).catch(() => null); // a deleted folder is skipped
    if (s && s.blocks > 0 && (s.blocks - s.bfree) / (s.blocks - s.bfree + s.bavail) > limit)
      return path;
  }
  return null;
}
