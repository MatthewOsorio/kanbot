import { runEvents, runs } from "@kanbot/shared/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Status = "ok" | "degraded" | "down" | "unknown";

/**
 * Health of the parts the board depends on (requirements §8). The worker is "up" while it holds a
 * Postgres connection named kanbot-worker; Anthropic is judged from the latest runs. GitHub stays "unknown" until phase 5c.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return Response.json({
      database: "down",
      worker: "unknown",
      anthropic: "unknown",
      github: "unknown",
    });
  }
  const [workers] = (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where application_name = 'kanbot-worker' and datname = current_database()`,
    )
  ).rows;
  const [last] = await db
    .select({ error: runs.error })
    .from(runs)
    .where(isNotNull(runs.endedAt))
    .orderBy(desc(runs.endedAt))
    .limit(1);
  // shortcut: one api_retry anywhere in a running run reads as degraded until that run ends; upgrade to "latest event is a retry" if it misleads.
  const [retrying] = await db
    .select({ id: runEvents.id })
    .from(runEvents)
    .innerJoin(runs, eq(runs.id, runEvents.runId))
    .where(and(eq(runs.state, "running"), sql`${runEvents.payload}->>'subtype' = 'api_retry'`))
    .limit(1);
  const anthropic: Status = retrying
    ? "degraded"
    : last?.error?.startsWith("Anthropic API error")
      ? "down"
      : last
        ? "ok"
        : "unknown";
  return Response.json({
    database: "ok",
    worker: workers && workers.n > 0 ? "ok" : "down",
    anthropic,
    github: "unknown",
  } satisfies Record<string, Status>);
}
