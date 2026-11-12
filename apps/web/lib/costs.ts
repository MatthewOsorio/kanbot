import type { costsQuery } from "@kanbot/shared";
import { costReport } from "@kanbot/shared/server";
import type { z } from "zod";
import { db } from "./db";

const DAY_MS = 24 * 3600 * 1000;

/** `from`..`to` are local dates, both days included; the default is the last 30 days. */
export async function costs(q: z.infer<typeof costsQuery>) {
  const day = (s: string) => new Date(`${s}T00:00:00`); // no zone suffix: local midnight, like spendToday
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const to = q.to ? new Date(day(q.to).getTime() + DAY_MS) : new Date(start.getTime() + DAY_MS);
  const from = q.from ? day(q.from) : new Date(to.getTime() - 30 * DAY_MS);
  const rows = await costReport(db, q.groupBy, from, to);
  const totals = rows.reduce(
    (t, r) => ({
      runs: t.runs + r.runs,
      costUsd: t.costUsd + r.costUsd,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
    }),
    { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
  return { rows, totals };
}
