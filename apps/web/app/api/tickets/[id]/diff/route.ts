import { idParam, route } from "@/lib/api";
import { getDiff } from "@/lib/tickets";

export const GET = route(async (_req, ctx) => Response.json(await getDiff(await idParam(ctx))));
