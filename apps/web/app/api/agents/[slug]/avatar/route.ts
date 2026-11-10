import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { agentsDir, loadAgent } from "@kanbot/shared/server";
import { notFound, route } from "@/lib/api";

/** Serves the avatar named in the agent's frontmatter, from the agents/ folder (requirements §8). */
export const GET = route(async (_req, ctx) => {
  const { slug } = await ctx.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw notFound();
  const agent = (() => {
    try {
      return loadAgent(slug);
    } catch {
      return null;
    }
  })();
  if (!agent) throw notFound("Agent not found");
  const dir = agentsDir();
  const file = resolve(dir, agent.avatar);
  if (!file.startsWith(dir) || !file.endsWith(".svg")) throw notFound(); // stay inside agents/, SVG only
  const svg = await readFile(file).catch(() => null);
  if (!svg) throw notFound("Avatar not found");
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": "no-cache",
    },
  });
});
