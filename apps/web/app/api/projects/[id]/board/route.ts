import { idParam, route } from "@/lib/api";
import { getBoard } from "@/lib/projects";

export const GET = route(async (_req, ctx) => Response.json(await getBoard(await idParam(ctx))));
