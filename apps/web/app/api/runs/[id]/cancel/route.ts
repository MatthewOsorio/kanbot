import { idParam, route } from "@/lib/api";
import { cancelRun } from "@/lib/runs";

export const POST = route(async (_req, ctx) => {
  await cancelRun(await idParam(ctx));
  return new Response(null, { status: 204 });
});
