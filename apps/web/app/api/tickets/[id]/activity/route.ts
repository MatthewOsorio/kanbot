import { idParam, route } from "@/lib/api";
import { listActivity } from "@/lib/tickets";

export const GET = route(async (_req, ctx) =>
  Response.json(await listActivity(await idParam(ctx))),
);
