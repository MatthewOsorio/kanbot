import { idParam, route } from "@/lib/api";
import { listRuns } from "@/lib/runs";

export const GET = route(async (_req, ctx) => Response.json(await listRuns(await idParam(ctx))));
