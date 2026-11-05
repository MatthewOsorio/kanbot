import { patchLinkBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { confirmLink, deleteLink } from "@/lib/links";

export const PATCH = route(async (req, ctx) => {
  const id = await idParam(ctx);
  await parseBody(req, patchLinkBody);
  return Response.json(await confirmLink(id));
});

export const DELETE = route(async (_req, ctx) => {
  await deleteLink(await idParam(ctx));
  return new Response(null, { status: 204 });
});
