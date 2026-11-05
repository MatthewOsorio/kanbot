import { createLinkBody } from "@kanbot/shared";
import { logActivity, projects, ticketLinks, tickets } from "@kanbot/shared/db";
import { and, eq, or } from "drizzle-orm";
import type { z } from "zod";
import { HttpError, notFound } from "./api";
import { db } from "./db";
import { publish, type Tx } from "./events";

/** Both tickets' drawers refetch, and each gets a timeline entry. */
async function changed(tx: Tx, projectId: string, ids: string[], change: string, kind: string) {
  for (const id of ids) {
    await logActivity(tx, id, "edited", { fields: ["links"], change, kind });
    await publish(tx, projectId, { type: "ticket.updated", ticketId: id, fields: ["links"] });
  }
}

/** The owner adds a link by key; it is confirmed at once. "blocked_by" is stored as the other ticket blocking this one. */
export function addLink(ticketId: string, { toKey, kind }: z.output<typeof createLinkBody>) {
  return db.transaction(async (tx) => {
    const [me] = await tx
      .select({ projectId: tickets.projectId, keyPrefix: projects.keyPrefix })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    if (!me) throw notFound("Ticket not found");
    const m = /^(.+)-(\d+)$/.exec(toKey.toUpperCase());
    const [other] =
      m && m[1] === me.keyPrefix
        ? await tx
            .select({ id: tickets.id })
            .from(tickets)
            .where(and(eq(tickets.projectId, me.projectId), eq(tickets.number, Number(m[2]))))
        : [];
    if (!other) throw notFound(`No ticket ${toKey} in this project`);
    if (other.id === ticketId)
      throw new HttpError(400, "invalid_link", "A ticket can't link to itself");
    const [link] = await tx
      .insert(ticketLinks)
      .values({
        projectId: me.projectId,
        fromTicketId: kind === "blocked_by" ? other.id : ticketId,
        toTicketId: kind === "blocked_by" ? ticketId : other.id,
        kind: kind === "relates" ? "relates" : "blocks",
        confirmed: true,
        source: "user",
      })
      .onConflictDoNothing()
      .returning();
    if (!link) throw new HttpError(409, "link_exists", "These tickets are already linked that way");
    await changed(tx, me.projectId, [ticketId, other.id], "added", kind);
    return link;
  });
}

export function confirmLink(id: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .update(ticketLinks)
      .set({ confirmed: true })
      .where(eq(ticketLinks.id, id))
      .returning();
    if (!link) throw notFound("Link not found");
    await changed(tx, link.projectId, [link.fromTicketId, link.toTicketId], "confirmed", link.kind);
    return link;
  });
}

/** Dismisses a proposal or removes a confirmed link. */
export function deleteLink(id: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.delete(ticketLinks).where(eq(ticketLinks.id, id)).returning();
    if (!link) throw notFound("Link not found");
    await changed(tx, link.projectId, [link.fromTicketId, link.toTicketId], "removed", link.kind);
  });
}

/** A ticket's links with the other end resolved, for the drawer. */
export async function linksOf(ticketId: string) {
  const rows = await db
    .select({
      link: ticketLinks,
      number: tickets.number,
      title: tickets.title,
      keyPrefix: projects.keyPrefix,
    })
    .from(ticketLinks)
    .innerJoin(
      tickets,
      or(
        and(eq(ticketLinks.fromTicketId, ticketId), eq(tickets.id, ticketLinks.toTicketId)),
        and(eq(ticketLinks.toTicketId, ticketId), eq(tickets.id, ticketLinks.fromTicketId)),
      ),
    )
    .innerJoin(projects, eq(projects.id, tickets.projectId));
  return rows.map(({ link, number, title, keyPrefix }) => ({
    id: link.id,
    // What the other ticket is to this one.
    relation:
      link.kind === "relates"
        ? ("relates" as const)
        : link.fromTicketId === ticketId
          ? ("blocks" as const)
          : ("blocked_by" as const),
    confirmed: link.confirmed,
    source: link.source,
    key: `${keyPrefix}-${number}`,
    title,
  }));
}
