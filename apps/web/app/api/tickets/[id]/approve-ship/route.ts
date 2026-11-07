import { idParam, route } from "@/lib/api";
import { approveShip } from "@/lib/runs";

export const POST = route(async (_req, ctx) => {
  await approveShip(await idParam(ctx));
  return new Response(null, { status: 204 });
});
