import { patchTicketBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { deleteTicket, getTicket, patchTicket } from "@/lib/tickets";

export const GET = route(async (_req, ctx) => Response.json(await getTicket(await idParam(ctx))));

export const PATCH = route(async (req, ctx) => {
  const id = await idParam(ctx);
  await patchTicket(id, await parseBody(req, patchTicketBody));
  return Response.json(await getTicket(id));
});

export const DELETE = route(async (_req, ctx) => {
  await deleteTicket(await idParam(ctx));
  return new Response(null, { status: 204 });
});
