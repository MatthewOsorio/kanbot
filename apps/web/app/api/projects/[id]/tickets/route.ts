import { createTicketBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { createTicket } from "@/lib/tickets";

export const POST = route(async (req, ctx) => {
  const projectId = await idParam(ctx);
  const ticket = await createTicket(projectId, await parseBody(req, createTicketBody));
  return Response.json(ticket, { status: 201 });
});
