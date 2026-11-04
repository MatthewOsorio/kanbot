import { resumeRunBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { resumeRun } from "@/lib/runs";

export const POST = route(async (req, ctx) => {
  const id = await idParam(ctx);
  const { answer } = await parseBody(req, resumeRunBody);
  return Response.json(await resumeRun(id, answer), { status: 201 });
});
