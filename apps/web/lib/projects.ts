import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEFAULT_COLUMNS, IN_FLIGHT_COLUMNS, createProjectBody } from "@kanbot/shared";
import { loadAgent } from "@kanbot/shared/agents";
import { columns, projects, ticketLinks, tickets } from "@kanbot/shared/db";
import { loadProjectConfig, overlap } from "@kanbot/shared/repo";
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
  const [cols, cards, links] = await Promise.all([
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
        bounceCount: tickets.bounceCount,
        touchPaths: tickets.touchPaths,
      })
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(sql`${tickets.position} collate "C"`, asc(tickets.id)),
    db
      .select({ from: ticketLinks.fromTicketId, to: ticketLinks.toTicketId })
      .from(ticketLinks)
      .where(
        sql`${ticketLinks.projectId} = ${projectId} and ${ticketLinks.kind} = 'blocks' and ${ticketLinks.confirmed}`,
      ),
  ]);
  const slugOf = new Map(cols.map((c) => [c.id, c.slug]));
  const key = (t: { number: number }) => `${project.keyPrefix}-${t.number}`;
  const byId = new Map(cards.map((c) => [c.id, c]));
  // shortcut: reads project.yml from git on every board fetch; P5 moves the hotspots into the database.
  const { hotspots } = project.repoPath
    ? await loadProjectConfig(project.repoPath, project.defaultBranch).catch(() => ({
        hotspots: [],
      }))
    : { hotspots: [] };
  const inFlight = cards.filter((c) =>
    (IN_FLIGHT_COLUMNS as readonly string[]).includes(slugOf.get(c.columnId)!),
  );
  return {
    project,
    columns: cols.map((c) => ({ ...c, agent: columnAgent(c.agentSlug) })),
    tickets: cards.map((c) => {
      const slug = slugOf.get(c.columnId)!;
      const active = slug === "ready" || (IN_FLIGHT_COLUMNS as readonly string[]).includes(slug);
      if (!active) return { ...c, waitingOn: [] as string[], overlaps: [] as string[] };
      const waitingOn = links
        .filter((l) => l.to === c.id)
        .map((l) => byId.get(l.from)!)
        .filter((b) => slugOf.get(b.columnId) !== "done")
        .map(key);
      const overlaps = inFlight
        .filter((o) => o.id !== c.id)
        .filter((o) => {
          const x = overlap(c.touchPaths, o.touchPaths, hotspots);
          return x.files.length || x.hotspots.length;
        })
        .map(key);
      return { ...c, waitingOn, overlaps };
    }),
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
