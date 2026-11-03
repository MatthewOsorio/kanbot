import { revisePlanBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { revisePlan } from "@/lib/runs";

export const POST = route(async (req, ctx) => {
  const id = await idParam(ctx);
  const { requestMd } = await parseBody(req, revisePlanBody);
  return Response.json(await revisePlan(id, requestMd), { status: 201 });
});
