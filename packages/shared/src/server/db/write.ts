import { sql } from "drizzle-orm";
import { EVENTS_CHANNEL, type BoardEvent, type EventEnvelope } from "../../events";
import { uuidv7 } from "../../ids";
import type { ActivityAction } from "../../schemas";
import type { Db } from "./index";
import { activity } from "./schema";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Publishes inside the caller's transaction, so listeners only hear about committed changes. */
export async function publish(tx: Tx, projectId: string, event: BoardEvent) {
  const envelope: EventEnvelope = { id: uuidv7(), projectId, event };
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(envelope)})`);
}

export type Actor = { kind: "user" | "agent"; name: string };
export const OWNER: Actor = { kind: "user", name: "owner" };
export const agentActor = (slug: string): Actor => ({ kind: "agent", name: slug });

export function logActivity(
  tx: Tx,
  ticketId: string,
  action: ActivityAction,
  data: object = {},
  actor: Actor = OWNER,
) {
  return tx.insert(activity).values({
    ticketId,
    action,
    actorKind: actor.kind,
    actor: actor.name,
    data: data as Record<string, unknown>,
  });
}

/** A ticket edit's timeline entry and event, which always go together. `data` joins the entry's fields. */
export async function ticketChanged(
  tx: Tx,
  ticket: { id: string; projectId: string },
  fields: string[],
  data: object = {},
  actor: Actor = OWNER,
) {
  await logActivity(tx, ticket.id, "edited", { fields, ...data }, actor);
  await publish(tx, ticket.projectId, { type: "ticket.updated", ticketId: ticket.id, fields });
}
