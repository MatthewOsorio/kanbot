import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_COLUMNS, EXTRA_AGENTS } from "@kanbot/shared";
import {
  agentHash,
  agentStats,
  agentsDir,
  agentVersions,
  loadAgent,
  parseAgentFile,
} from "@kanbot/shared/server";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { HttpError, notFound } from "./api";
import { db } from "./db";

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** The agents on the board, in column order; a column without a file (or without an agent) is left out. */
const slugs = [
  ...DEFAULT_COLUMNS.flatMap((c) => (c.agentSlug ? [c.agentSlug] : [])),
  ...EXTRA_AGENTS, // Dr. Rabbit Hole: no column of his own
];

type Week = { runs: number; successRate: number | null; avgCostUsd: number };
export type RosterEntry =
  | {
      slug: string;
      name: string;
      tagline: string;
      column: string;
      model: string;
      color: string;
      hash: string;
      week: Week;
    }
  | { slug: string; error: string; week: Week };

/** Roster cards (§13): each agent's file summary and its stats this week. An invalid file shows its error. */
export async function roster() {
  const stats = new Map(
    (await agentStats(db, new Date(Date.now() - WEEK_MS))).map((s) => [s.agentSlug, s]),
  );
  return slugs.flatMap((slug): RosterEntry[] => {
    const s = stats.get(slug);
    const week = {
      runs: s?.runs ?? 0,
      successRate: s?.finished ? s.succeeded / s.finished : null,
      avgCostUsd: s?.avgCostUsd ?? 0,
    };
    try {
      const a = loadAgent(slug);
      if (!a) return [];
      const { name, tagline, column, model, color, hash } = a;
      return [{ slug, name, tagline, column, model, color, hash, week }];
    } catch (e) {
      return [{ slug, error: errorMessage(e), week }];
    }
  });
}

/** The zod message for a bad frontmatter, the plain message for anything else. */
const errorMessage = (e: unknown) =>
  e instanceof ZodError
    ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")
    : (e as Error).message;

function assertShipped(slug: string) {
  if (!slugs.includes(slug as never)) throw notFound("Agent not found");
}

/** The file's text and hash; with `version`, the saved text of that version instead (a past run's). */
export async function readAgent(slug: string, version?: string) {
  assertShipped(slug);
  if (version) {
    const [v] = await db.select().from(agentVersions).where(eq(agentVersions.hash, version));
    if (!v || v.slug !== slug) throw notFound("Version not found");
    return { text: v.text, hash: v.hash };
  }
  try {
    const a = loadAgent(slug);
    if (!a) throw notFound("Agent file not found");
    return { text: a.text, hash: a.hash };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Invalid on disk: the editor still needs the text to fix it.
    const text = readFileSync(resolve(agentsDir(), `${slug}.md`), "utf8");
    return { text, hash: agentHash(text), error: errorMessage(e) };
  }
}

/**
 * Saves an edited agent file (FR-30 applies it to the next run). The text must parse, keep the file's slug and
 * column (the board's column map is fixed), and is swapped in atomically so a run never reads half a file.
 */
export function saveAgent(slug: string, text: string) {
  assertShipped(slug);
  const current = loadAgent(slug);
  let next;
  try {
    next = parseAgentFile(text);
  } catch (e) {
    throw new HttpError(400, "invalid_agent", errorMessage(e));
  }
  if (next.slug !== slug) throw new HttpError(400, "invalid_agent", `slug must stay "${slug}"`);
  if (current && next.column !== current.column)
    throw new HttpError(400, "invalid_agent", `column must stay "${current.column}"`);
  const dir = agentsDir();
  mkdirSync(dir, { recursive: true });
  const tmp = resolve(dir, `.${slug}.md.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, resolve(dir, `${slug}.md`));
  return { hash: agentHash(text) };
}
