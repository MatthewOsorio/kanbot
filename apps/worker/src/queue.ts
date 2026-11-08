// Which run goes next, and which come back after a crash, an outage or Pause all (§8).
import { ANTHROPIC_API_ERROR } from "@kanbot/shared";
import { loadAgent } from "@kanbot/shared/agents";
import {
  activeRun,
  columns,
  getSettings,
  runs,
  spendToday,
  startColumnAgent,
  tickets,
  type Db,
  agentActor,
} from "@kanbot/shared/db";
import { and, eq, sql } from "drizzle-orm";
import { finish } from "./finish";
import type { Run } from "./results";

/** Requirements §14 concurrency defaults; a project's settings.concurrency overrides perProject. */
export const LIMITS = { global: 2, perProject: 1 };

/**
 * Claims the oldest queued run that fits the concurrency limits (requirements §8 step 2).
 * Only `queued` rows are claimed, so a run is never executed twice. The advisory lock makes the
 * limit checks exact even if two claims race.
 */
export async function claimNext(db: Db): Promise<Run | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kanbot_claim'))`);
    // Pause all (FR-63) and the daily cap (§14): nothing new starts.
    const s = await getSettings(tx);
    const { spent, reserved } = await spendToday(tx);
    const left = s.dailyBudgetUsd - spent - reserved;
    if (s.paused || left < 0.01) return null; // the cap is in cents, spend in hundredths of a cent
    const res = await tx.execute<{ id: string }>(sql`
      update runs set state = 'running', started_at = now()
      where id = (
        select r.id from runs r join tickets t on t.id = r.ticket_id
        where r.state = 'queued'
          and (select count(*) from runs where state = 'running') < ${LIMITS.global}
          and (select count(*) from runs r2 join tickets t2 on t2.id = r2.ticket_id
               where r2.state = 'running' and t2.project_id = t.project_id) < coalesce((select (p.settings->>'concurrency')::int from projects p where p.id = t.project_id), ${LIMITS.perProject})
        order by r.created_at
        limit 1
        for update of r skip locked)
      returning id`);
    const id = res.rows[0]?.id;
    if (!id) return null;
    const [claimed] = await tx.select().from(runs).where(eq(runs.id, id));
    let agentBudget = left;
    try {
      agentBudget = loadAgent(claimed!.agentSlug)?.maxBudgetUsd ?? left;
    } catch {
      // invalid agent file: execute() fails the run with the validation error
    }
    const [run] = await tx
      .update(runs)
      .set({ budgetUsd: Math.min(agentBudget, left) })
      .where(eq(runs.id, id))
      .returning();
    return run!;
  });
}

/** Error of a run stopped by Pause all; such runs, like outage ones, restart on their own (§8). */
export const PAUSED_ERROR = "Stopped by Pause all";

/**
 * Restarts runs that an outage or Pause all interrupted (requirements §8 failure handling), once agents
 * aren't paused and `reachable()` (the Anthropic probe) says the API is back. Only a ticket's latest run,
 * still in its column with nothing active, restarts: anything the owner did since wins.
 */
export async function resumeInterrupted(db: Db, reachable: () => Promise<boolean>) {
  const candidates = await db.execute<{ id: string }>(sql`
    select r.id from runs r
    join tickets t on t.id = r.ticket_id
    join columns c on c.id = t.column_id and c.slug = r.column_slug
    where r.state = 'interrupted'
      and (r.error = ${PAUSED_ERROR} or r.error like ${`${ANTHROPIC_API_ERROR}%`})
      and not exists (select 1 from runs r2 where r2.ticket_id = r.ticket_id and r2.created_at > r.created_at)`);
  if (!candidates.rows.length) return 0;
  if ((await getSettings(db)).paused || !(await reachable())) return 0;
  let n = 0;
  for (const { id } of candidates.rows)
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: runs, ticket: tickets, column: columns })
        .from(runs)
        .innerJoin(tickets, eq(tickets.id, runs.ticketId))
        .innerJoin(columns, eq(columns.id, tickets.columnId))
        .where(eq(runs.id, id))
        .for("update", { of: tickets });
      // Re-checked under the ticket lock: the owner may have moved, retried or deleted it meanwhile.
      if (!row || row.column.slug !== row.run.columnSlug || (await activeRun(tx, row.ticket.id)))
        return;
      const [newer] = await tx
        .select({ id: runs.id })
        .from(runs)
        // In SQL: a JS Date drops the microseconds, so the run would count as newer than itself.
        .where(
          and(
            eq(runs.ticketId, row.ticket.id),
            sql`${runs.createdAt} > (select created_at from runs where id = ${id})`,
          ),
        )
        .limit(1);
      if (newer) return;
      const started = await startColumnAgent(
        tx,
        row.ticket.projectId,
        row.ticket.id,
        row.column,
        agentActor(row.run.agentSlug),
      );
      if (started) n++;
    });
  return n;
}

const byTicket = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` once the ticket's previous run in this process has fully stopped. A cancel marks the row
 * `cancelled` at once, but the aborted agent can still be writing to the worktree for a moment, and the
 * next column's run is already queued: started early, its snapshot would blame it for those writes.
 */
export function afterPrevious<T>(ticketId: string, fn: () => Promise<T>): Promise<T> {
  const p = (byTicket.get(ticketId) ?? Promise.resolve()).then(fn);
  const settled = p.catch(() => {});
  byTicket.set(ticketId, settled);
  void settled.then(() => byTicket.get(ticketId) === settled && byTicket.delete(ticketId));
  return p;
}

/** Crash recovery (requirements §8): runs left `running` by a dead worker become `interrupted`. */
export async function recoverInterrupted(db: Db) {
  const stale = await db.select({ id: runs.id }).from(runs).where(eq(runs.state, "running"));
  for (const { id } of stale)
    await finish(db, id, {
      state: "interrupted",
      error: "The worker stopped while this run was in progress",
    });
  return stale.length;
}
