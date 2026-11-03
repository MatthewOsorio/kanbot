import { createCriterionBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { addCriterion } from "@/lib/tickets";

export const POST = route(async (req, ctx) => {
  const id = await idParam(ctx);
  return Response.json(await addCriterion(id, await parseBody(req, createCriterionBody)), {
    status: 201,
  });
});
