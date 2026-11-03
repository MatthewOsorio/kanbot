/** Postgres NOTIFY channel shared by web and (from M2) worker. */
export const EVENTS_CHANNEL = "kanbot_events";

/** Board events streamed over SSE (requirements §12). */
export type BoardEvent =
  | { type: "ticket.created"; ticketId: string }
  | {
      type: "ticket.moved";
      ticketId: string;
      fromColumnId: string;
      toColumnId: string;
      position: string;
      actor: string;
    }
  | { type: "ticket.updated"; ticketId: string; fields: string[] }
  | { type: "ticket.deleted"; ticketId: string }
  | { type: "comment.created"; ticketId: string; commentId: string };

/** Payload sent on EVENTS_CHANNEL; projectId routes it to the right SSE subscribers. */
export type EventEnvelope = { id: string; projectId: string; event: BoardEvent };
