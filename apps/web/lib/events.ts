import { EVENTS_CHANNEL, type EventEnvelope } from "@kanbot/shared";
import { Client } from "pg";

// publish() lives in shared so the worker writes events the same way.
export { publish, type Tx } from "@kanbot/shared/db";

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
      setTimeout(() => void ensureListening().catch(console.error), 1000);
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
