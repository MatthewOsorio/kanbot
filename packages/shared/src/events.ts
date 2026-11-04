import type { RunEventType, RunState } from "./schemas";

/** Postgres NOTIFY channel shared by web and worker. */
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
  | { type: "comment.created"; ticketId: string; commentId: string }
  | { type: "artifact.created"; ticketId: string; artifactId: string }
  | {
      type: "run.started" | "run.finished";
      runId: string;
      ticketId: string;
      agentSlug: string;
      state: RunState;
      verdict?: string;
      costUsd?: number;
    }
  // Ids only: NOTIFY payloads are capped at 8 KB, so clients page GET /api/runs/:id/events?after=seq.
  | { type: "run.event"; runId: string; ticketId: string; seq: number; eventType: RunEventType }
  // Global (projectId "*"): Pause all or the daily cap changed. The worker aborts its runs on `paused`.
  | { type: "settings.updated"; paused: boolean };

/** Payload sent on EVENTS_CHANNEL; projectId routes it to the right SSE subscribers ("*" = all). */
export type EventEnvelope = { id: string; projectId: string; event: BoardEvent };
