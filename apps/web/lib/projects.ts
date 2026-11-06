import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  DEFAULT_COLUMNS,
  IN_FLIGHT_COLUMNS,
  createProjectBody,
  type patchProjectBody,
} from "@kanbot/shared";
import { loadAgent } from "@kanbot/shared/agents";
import { columns, projectConfigOf, projects, ticketLinks, tickets } from "@kanbot/shared/db";
import { overlap } from "@kanbot/shared/repo";
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
        parentId: tickets.parentId,
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
  const { hotspots } = await projectConfigOf(db, project);
  const inFlight = cards.filter((c) =>
    (IN_FLIGHT_COLUMNS as readonly string[]).includes(slugOf.get(c.columnId)!),
  );
  return {
    project,
    columns: cols.map((c) => ({ ...c, agent: columnAgent(c.agentSlug) })),
    tickets: cards.map((card) => {
      // An epic's progress: its children, and how many of them are Done (UC-11).
      const kids = card.type === "epic" ? cards.filter((k) => k.parentId === card.id) : [];
      const c = {
        ...card,
        epic: kids.length
          ? {
              total: kids.length,
              done: kids.filter((k) => slugOf.get(k.columnId) === "done").length,
            }
          : null,
      };
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
        color: a.color,
        startLine: a.statusLines.running ?? `${a.name} is on it.`,
      }
    );
  } catch {
    return null; // invalid file: the run itself reports the error
  }
}

export type Board = Awaited<ReturnType<typeof getBoard>>;
export type Card = Board["tickets"][number];

/** Settings page data (§13). The first read seeds a project from .kanbot/project.yml. */
export async function getProjectSettings(id: string) {
  const [p] = await db.select().from(projects).where(eq(projects.id, id));
  if (!p) throw notFound("Project not found");
  const { commands, testGlobs, hotspots, bounceLimit, concurrency } = await projectConfigOf(db, p);
  return {
    id,
    name: p.name,
    keyPrefix: p.keyPrefix,
    commands,
    testGlobs,
    hotspots,
    bounceLimit,
    concurrency,
  };
}

export async function patchProject(id: string, input: z.output<typeof patchProjectBody>) {
  const [p] = await db.select().from(projects).where(eq(projects.id, id));
  if (!p) throw notFound("Project not found");
  // Seed first so a partial patch (one command) doesn't hide the rest of project.yml behind nulls.
  const cur = await projectConfigOf(db, p);
  const { bounceLimit, concurrency, commands, testGlobs, hotspots } = input;
  await db
    .update(projects)
    .set({
      // An empty command clears it; never store "" (projectConfig refuses it, and every read would fail).
      commands: Object.fromEntries(
        Object.entries({ ...cur.commands, ...commands }).filter(([, v]) => v),
      ),
      testGlobs: testGlobs ?? cur.testGlobs,
      hotspots: hotspots ?? cur.hotspots,
      settings: {
        bounceLimit: bounceLimit ?? cur.bounceLimit,
        concurrency: concurrency ?? cur.concurrency,
      },
    })
    .where(eq(projects.id, id));
  return getProjectSettings(id);
}
