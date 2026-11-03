import { moveTicketBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { moveTicket } from "@/lib/tickets";

export const POST = route(async (req, ctx) => {
  const id = await idParam(ctx);
  await moveTicket(id, await parseBody(req, moveTicketBody));
  return new Response(null, { status: 204 });
});
