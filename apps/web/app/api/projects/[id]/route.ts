import { patchProjectBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { getProjectSettings, patchProject } from "@/lib/projects";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, ctx) =>
  Response.json(await getProjectSettings(await idParam(ctx))),
);

/** Project Settings (§13): commands, test globs, hotspots, bounce limit, concurrency. */
export const PATCH = route(async (req, ctx) =>
  Response.json(await patchProject(await idParam(ctx), await parseBody(req, patchProjectBody))),
);
