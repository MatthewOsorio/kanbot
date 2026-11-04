import { EVENTS_CHANNEL, type EventEnvelope } from "@kanbot/shared";
import { createDb } from "@kanbot/shared/db";
import { Client } from "pg";
import { afterPrevious, claimNext, executeRun, LIMITS, recoverInterrupted } from "./run";
import { ReplayRuntime } from "./runtime/replay";
import { SdkRuntime } from "./runtime/sdk";
import type { AgentRuntime } from "./runtime/types";

try {
  process.loadEnvFile("../../.env"); // one .env at the repo root for every package
} catch {
  // no .env: rely on the real environment
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
const db = createDb(url, "kanbot-worker"); // the health check looks for this application_name
const runtime: AgentRuntime =
  process.env.KANBOT_RUNTIME === "replay" ? new ReplayRuntime() : new SdkRuntime();
if (!(runtime instanceof ReplayRuntime) && !process.env.ANTHROPIC_API_KEY)
  console.warn(
    "ANTHROPIC_API_KEY is not set: SDK runs will fail. Set KANBOT_RUNTIME=replay for scripted runs.",
  );

const active = new Map<string, AbortController>();
let pumping = false;
let again = false;

/** Claims runs until the concurrency limit is reached or the queue is empty. */
async function pump() {
  if (pumping) return void (again = true);
  pumping = true;
  try {
    do {
      again = false;
      while (active.size < LIMITS.global) {
        const run = await claimNext(db);
        if (!run) break;
        const ac = new AbortController();
        active.set(run.id, ac);
        console.log(`run ${run.id} (${run.agentSlug}) started`);
        // Cancelled while waiting for the ticket's previous run: the web app already wrote `cancelled`.
        afterPrevious(run.ticketId, async () => {
          if (!ac.signal.aborted) await executeRun(db, runtime, run, ac.signal);
        })
          .catch((e) => console.error(`run ${run.id} crashed`, e))
          .finally(() => {
            active.delete(run.id);
            console.log(`run ${run.id} finished`);
            void pump();
          });
      }
    } while (again);
  } catch (e) {
    console.error("claiming failed; retrying on the next tick", e); // e.g. database down (§8)
  } finally {
    pumping = false;
  }
}

/** New runs wake the worker; a run.finished for a run we hold means it was cancelled. */
async function listen() {
  const client = new Client({ connectionString: url, application_name: "kanbot-worker" });
  // shortcut: notifications sent while reconnecting are missed; the 5 s poll picks up queued runs, but a cancel in that gap only lands when the run ends. Upgrade by re-checking active runs' states on reconnect.
  const reconnect = () => {
    client.end().catch(() => {});
    setTimeout(() => listen().catch(console.error), 1000);
  };
  client.on("error", reconnect);
  client.on("notification", (msg) => {
    if (!msg.payload) return;
    const { event } = JSON.parse(msg.payload) as EventEnvelope;
    if (event.type === "run.started") void pump();
    if (event.type === "run.finished") active.get(event.runId)?.abort();
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
  } catch (e) {
    console.error("LISTEN failed", e);
    reconnect();
  }
}

// One worker per database: crash recovery below would mark a live worker's runs interrupted.
const lock = new Client({ connectionString: url, application_name: "kanbot-worker" });
// shortcut: if this connection drops, the lock goes with it and a second worker could start; fine for one dev machine, revisit with deployment (M5).
lock.on("error", (e) => console.warn("worker lock connection lost", e.message));
await lock.connect();
const { rows } = await lock.query<{ ok: boolean }>(
  "select pg_try_advisory_lock(hashtext('kanbot_worker')) as ok",
);
if (!rows[0]?.ok) {
  console.error(
    "Another Kanbot worker is already running on this database. Not starting a second.",
  );
  process.exit(1);
}

const recovered = await recoverInterrupted(db);
if (recovered) console.log(`marked ${recovered} run(s) interrupted after a restart`);
await listen();
setInterval(() => void pump(), 5_000);
void pump();
console.log(`kanbot worker up (runtime: ${runtime instanceof ReplayRuntime ? "replay" : "sdk"})`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    // Runs still going are marked interrupted on the next start (crash recovery covers shutdowns too).
    process.exit(0);
  });
