import { z } from "zod";
import { idParam, route } from "@/lib/api";
import { listRunEvents } from "@/lib/runs";

const after = z.coerce.number().int().min(0).catch(0);

export const GET = route(async (req, ctx) =>
  Response.json(
    await listRunEvents(
      await idParam(ctx),
      after.parse(new URL(req.url).searchParams.get("after")),
    ),
  ),
);
