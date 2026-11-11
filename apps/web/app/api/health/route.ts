import { ANTHROPIC_API_ERROR } from "@kanbot/shared";
import { appJwt, gh, GitHubError, loadGitHubApp, runEvents, runs } from "@kanbot/shared/server";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Status = "ok" | "degraded" | "down" | "unknown";

/**
 * Health of the parts the board depends on (requirements §8). The worker is "up" while it holds a
 * Postgres connection named kanbot-worker; Anthropic is judged from the latest runs; GitHub from a call with the App's key.
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
    : last?.error?.startsWith(ANTHROPIC_API_ERROR)
      ? "down"
      : last
        ? "ok"
        : "unknown";
  return Response.json({
    database: "ok",
    worker: workers && workers.n > 0 ? "ok" : "down",
    anthropic,
    github: await githubStatus(),
  } satisfies Record<string, Status>);
}

/** Can the App's own key still talk to GitHub? No App is "unknown"; an outage is "down", a refused key "degraded". */
async function githubStatus(): Promise<Status> {
  try {
    const app = await loadGitHubApp(db);
    if (!app) return "unknown";
    await gh(appJwt(app), "/app");
    return "ok";
  } catch (e) {
    return e instanceof GitHubError && e.status < 500 ? "degraded" : "down";
  }
}
