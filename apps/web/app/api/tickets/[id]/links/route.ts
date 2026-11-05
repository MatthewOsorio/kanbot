import { createLinkBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { addLink } from "@/lib/links";

export const POST = route(async (req, ctx) => {
  const id = await idParam(ctx);
  return Response.json(await addLink(id, await parseBody(req, createLinkBody)), { status: 201 });
});
