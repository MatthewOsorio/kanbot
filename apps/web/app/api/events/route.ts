import { z } from "zod";
import { subscribe } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE stream of board events for one project (requirements §12).
 * shortcut: no Last-Event-ID replay; the client refetches the board on (re)connect instead. Upgrade if a client ever needs event history.
 */
export function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!z.uuid().safeParse(projectId).success)
    return Response.json(
      { error: { code: "invalid_query", message: "projectId must be a UUID" } },
      { status: 400 },
    );

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      const unsubscribe = await subscribe(({ id, projectId: p, event }) => {
        // Unnamed SSE events so the client's single onmessage sees all of them; `type` is in the data.
        if (p === projectId || p === "*") send(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed by cancel()
        }
      });
      send(": connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
