import { idParam, route } from "@/lib/api";
import { retryRun } from "@/lib/runs";

export const POST = route(async (_req, ctx) =>
  Response.json(await retryRun(await idParam(ctx)), { status: 201 }),
);
