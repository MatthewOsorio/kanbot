// `pnpm eval:agents` (requirements §8 "Checking agent quality"): runs the golden tickets end to end on a
// fresh copy of fixtures/sample-repo, Planning → (auto-approve) → In Progress → … until every run is
// done, then compares with evals/baseline.json. Uses the real SDK unless KANBOT_RUNTIME=replay. With
// KANBOT_RECORD=1 every run is also saved as a replay script (fixtures/runs/<agent>/golden-<slug>.<n>.json).
// Costs real money: the per-run budgets in the agent files still apply.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { activeRunStates, DEFAULT_COLUMNS } from "@kanbot/shared";
import {
  columns,
  createDb,
  moveToColumnEnd,
  projects,
  runs,
  settings,
  spendToday,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/db";
import {
  prepareSampleRepo,
  prepareTestDatabase,
  TEST_DATABASE_URL,
} from "@kanbot/shared/db/testing";
import { git } from "@kanbot/shared/repo";
import { and, eq, inArray } from "drizzle-orm";
import { claimNext, executeRun } from "./run";
import { ReplayRuntime } from "./runtime/replay";
import { SdkRuntime } from "./runtime/sdk";

try {
  process.loadEnvFile("../../.env");
} catch {
  // no .env: rely on the real environment
}
const replay = process.env.KANBOT_RUNTIME === "replay";
if (!replay && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
const runtime = replay ? new ReplayRuntime() : new SdkRuntime();
const root = resolve("../..");
const goldenDir = join(root, "fixtures/golden");
const evalsDir = join(root, "evals");
/** Pass bar (§8): any golden ticket not finishing, or total bounces or cost up by more than this. */
const TOLERANCE = 0.25;
const only = process.argv
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  .split(",");
if (only && process.argv.includes("--baseline"))
  throw new Error("--baseline needs every golden ticket");

type Golden = { title: string; type: "feature" | "bug"; description: string };
type Result = {
  slug: string;
  reachedQa: boolean;
  column: string;
  bounces: number;
  costUsd: number;
  seconds: number;
  diff: string;
};

await prepareTestDatabase();
const db = createDb(TEST_DATABASE_URL, "kanbot-eval");
// The normal $5 daily cap (§17), counted from now: replay tests' made-up costs share this database.
await db
  .update(settings)
  .set({ dailyBudgetUsd: (await spendToday(db)).spent + 5 })
  .where(eq(settings.id, 1));
// claimNext is global: don't pick up leftovers from tests.
await db
  .update(runs)
  .set({ state: "cancelled" })
  .where(inArray(runs.state, [...activeRunStates]));

const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-eval-")), "repo"));
const [project] = await db
  .insert(projects)
  .values({
    name: "Golden eval",
    keyPrefix: `EV${Date.now().toString(36).toUpperCase().slice(-6)}`,
    repoPath: repo,
  })
  .returning();
const cols = await db
  .insert(columns)
  .values(DEFAULT_COLUMNS.map((c, i) => ({ ...c, projectId: project!.id, position: i })))
  .returning();
const col = (slug: string) => cols.find((c) => c.slug === slug)!;
const owner = { kind: "user" as const, name: "eval" };

const slugs = readdirSync(goldenDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  // --only=bug,ui runs a subset (a smoke run); a subset never becomes the baseline.
  .filter((slug) => !only || only.includes(slug));
const ids = new Map<string, string>();
for (const [i, slug] of slugs.entries()) {
  const g = JSON.parse(readFileSync(join(goldenDir, `${slug}.json`), "utf8")) as Golden;
  const [t] = await db
    .insert(tickets)
    .values({
      projectId: project!.id,
      number: i + 1,
      title: g.title,
      type: g.type,
      descriptionMd: g.description,
      labels: [`replay:golden-${slug}`],
      columnId: col("planning").id,
      position: `a${i}`,
    })
    .returning();
  ids.set(slug, t!.id);
  await db.transaction((tx) => startColumnAgent(tx, project!.id, t!.id, col("planning"), owner));
}

// The worker's claim loop, synchronously; a ready plan is approved straight into In Progress.
const started = Date.now();
for (;;) {
  const run = await claimNext(db);
  if (run) {
    console.log(
      `→ ${run.agentSlug} on ticket ${[...ids].find(([, id]) => id === run.ticketId)?.[0]}`,
    );
    await executeRun(db, runtime, run, new AbortController().signal);
    continue;
  }
  const ready = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, project!.id), eq(tickets.statusFlag, "plan_ready")));
  if (!ready.length) break;
  for (const t of ready)
    await db.transaction(async (tx) => {
      await moveToColumnEnd(tx, t, col("planning"), col("in_progress"), owner);
      await startColumnAgent(tx, project!.id, t.id, col("in_progress"), owner);
    });
}

const results: Result[] = [];
for (const [slug, id] of ids) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, id));
  const done = await db.select().from(runs).where(eq(runs.ticketId, id));
  results.push({
    slug,
    reachedQa: t!.columnId === col("qa").id && t!.statusFlag === "awaiting_approval",
    column: cols.find((c) => c.id === t!.columnId)!.slug,
    bounces: t!.bounceCount,
    costUsd: Number(done.reduce((n, r) => n + r.costUsd, 0).toFixed(4)),
    seconds: Math.round(
      done.reduce((n, r) => n + ((r.endedAt?.getTime() ?? 0) - (r.startedAt?.getTime() ?? 0)), 0) /
        1000,
    ),
    diff: t!.branchName
      ? (await git(repo, ["diff", "--shortstat", `main...${t!.branchName}`])).trim()
      : "",
  });
}
await db.$client.end();

console.table(results);
const total = (rs: Result[], k: "bounces" | "costUsd") => rs.reduce((n, r) => n + r[k], 0);
const problems = results
  .filter((r) => !r.reachedQa)
  .map((r) => `${r.slug} did not reach QA (${r.column})`);
let baseline: Result[] | null = null;
try {
  baseline = JSON.parse(readFileSync(join(evalsDir, "baseline.json"), "utf8")).results as Result[];
} catch {
  console.log("No evals/baseline.json yet: run with --baseline to save this run as the baseline.");
}
if (baseline)
  for (const k of ["bounces", "costUsd"] as const) {
    const [was, now] = [total(baseline, k), total(results, k)];
    if (now > was * (1 + TOLERANCE) && now - was > 0.001)
      problems.push(`total ${k} rose from ${was} to ${now} (more than ${TOLERANCE * 100}%)`);
  }

const report = {
  at: new Date().toISOString(),
  runtime: replay ? "replay" : "sdk",
  minutes: Math.round((Date.now() - started) / 6_000) / 10,
  results,
  problems,
};
await mkdir(join(evalsDir, "results"), { recursive: true });
const out = join(evalsDir, "results", `${report.at.replace(/[:.]/g, "-")}.json`);
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
if (process.argv.includes("--baseline"))
  await writeFile(join(evalsDir, "baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Saved ${out}`);
if (problems.length) {
  console.log(`Needs the owner's OK before merging:\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
} else console.log("Pass: every golden ticket reached QA within the baseline's bounces and cost.");
