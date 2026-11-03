import { patchCriterionBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { deleteCriterion, patchCriterion } from "@/lib/tickets";

export const PATCH = route(async (req, ctx) => {
  const id = await idParam(ctx);
  return Response.json(await patchCriterion(id, await parseBody(req, patchCriterionBody)));
});

export const DELETE = route(async (_req, ctx) => {
  await deleteCriterion(await idParam(ctx));
  return new Response(null, { status: 204 });
});
