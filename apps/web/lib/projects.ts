import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEFAULT_COLUMNS, createProjectBody } from "@kanbot/shared";
import { loadAgent } from "@kanbot/shared/agents";
import { columns, projects, tickets } from "@kanbot/shared/db";
import { asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { HttpError, isUniqueViolation, notFound } from "./api";
import { db } from "./db";

export function listProjects() {
  return db.select().from(projects).orderBy(asc(projects.createdAt));
}

export async function createProject(input: z.output<typeof createProjectBody>) {
  if (input.repoPath !== undefined) {
    let dir = false;
    try {
      dir = isAbsolute(input.repoPath) && statSync(input.repoPath).isDirectory();
    } catch {
      // missing path: reported below
    }
    if (!dir)
      throw new HttpError(
        400,
        "invalid_repo_path",
        "Repo path must be an absolute path to an existing folder",
      );
  }
  try {
    return await db.transaction(async (tx) => {
      const [project] = await tx.insert(projects).values(input).returning();
      await tx
        .insert(columns)
        .values(DEFAULT_COLUMNS.map((c, i) => ({ ...c, projectId: project!.id, position: i })));
      return project!;
    });
  } catch (e) {
    if (isUniqueViolation(e))
      throw new HttpError(409, "key_prefix_taken", `Key prefix ${input.keyPrefix} is already used`);
    throw e;
  }
}

/** Everything the board renders, in one call (requirements §12). */
export async function getBoard(projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound("Project not found");
  const [cols, cards] = await Promise.all([
    db
      .select()
      .from(columns)
      .where(eq(columns.projectId, projectId))
      .orderBy(asc(columns.position)),
    db
      .select({
        id: tickets.id,
        number: tickets.number,
        title: tickets.title,
        type: tickets.type,
        priority: tickets.priority,
        labels: tickets.labels,
        columnId: tickets.columnId,
        position: tickets.position,
        statusFlag: tickets.statusFlag,
      })
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(sql`${tickets.position} collate "C"`, asc(tickets.id)),
  ]);
  return {
    project,
    columns: cols.map((c) => ({ ...c, agent: columnAgent(c.agentSlug) })),
    tickets: cards,
  };
}

/** What the board shows about a column's agent; null when its file hasn't shipped (the column is a gate). */
function columnAgent(slug: string | null) {
  if (!slug) return null;
  try {
    const a = loadAgent(slug);
    return (
      a && {
        slug: a.slug,
        name: a.name,
        tagline: a.tagline,
        startLine: a.statusLines.running ?? `${a.name} is on it.`,
      }
    );
  } catch {
    return null; // invalid file: the run itself reports the error
  }
}

export type Board = Awaited<ReturnType<typeof getBoard>>;
export type Card = Board["tickets"][number];
