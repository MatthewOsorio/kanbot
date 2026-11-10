import { EVENTS_CHANNEL, type EventEnvelope } from "@kanbot/shared";
import { Client } from "pg";

// publish() lives in shared so the worker writes events the same way.
export { publish, type Tx } from "@kanbot/shared/server";

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
      fanOut(JSON.parse(msg.payload) as EventEnvelope);
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

/** Every listener gets the event: one whose stream already closed must not starve the rest. */
export function fanOut(envelope: EventEnvelope) {
  for (const l of listeners)
    try {
      l(envelope);
    } catch {
      listeners.delete(l);
    }
}

export async function subscribe(listener: Listener): Promise<() => void> {
  listeners.add(listener);
  try {
    await ensureListening();
  } catch (e) {
    listeners.delete(listener); // its stream fails with this error; the browser reconnects
    throw e;
  }
  return () => listeners.delete(listener);
}
