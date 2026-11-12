import { putAgentBody } from "@kanbot/shared";
import { parseBody, route } from "@/lib/api";
import { readAgent, saveAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";

export const GET = route(async (req, ctx) => {
  const { slug } = await ctx.params;
  return Response.json(
    await readAgent(slug!, new URL(req.url).searchParams.get("version") ?? undefined),
  );
});

export const PUT = route(async (req, ctx) => {
  const { slug } = await ctx.params;
  const { text } = await parseBody(req, putAgentBody);
  return Response.json(saveAgent(slug!, text));
});
