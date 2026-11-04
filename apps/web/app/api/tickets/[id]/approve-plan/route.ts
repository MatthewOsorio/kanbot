import { idParam, route } from "@/lib/api";
import { approvePlan } from "@/lib/runs";

export const POST = route(async (_req, ctx) => {
  await approvePlan(await idParam(ctx));
  return new Response(null, { status: 204 });
});
