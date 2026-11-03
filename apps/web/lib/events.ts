import { EVENTS_CHANNEL, uuidv7, type BoardEvent, type EventEnvelope } from "@kanbot/shared";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import type { db } from "./db";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Publishes inside the caller's transaction, so listeners only hear about committed changes. */
export async function publish(tx: Tx, projectId: string, event: BoardEvent) {
  const envelope: EventEnvelope = { id: uuidv7(), projectId, event };
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(envelope)})`);
}

type Listener = (e: EventEnvelope) => void;
const g = globalThis as { kanbotListeners?: Set<Listener>; kanbotListen?: Promise<void> };
const listeners = (g.kanbotListeners ??= new Set());

/** One LISTEN connection per server process, fanned out to every open SSE stream. */
function ensureListening(): Promise<void> {
  return (g.kanbotListen ??= (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    // shortcut: events NOTIFYed while reconnecting are lost; open tabs only resync on their own reconnect or next event. Upgrade to replay from activity if that bites.
    const reconnect = () => {
      g.kanbotListen = undefined;
      client.end().catch(() => {});
      setTimeout(() => ensureListening().catch(console.error), 1000);
    };
    client.on("error", reconnect);
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      const envelope = JSON.parse(msg.payload) as EventEnvelope;
      for (const l of listeners) l(envelope);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (e) {
      reconnect();
      throw e;
    }
  })());
}

export async function subscribe(listener: Listener): Promise<() => void> {
  listeners.add(listener);
  await ensureListening();
  return () => listeners.delete(listener);
}
