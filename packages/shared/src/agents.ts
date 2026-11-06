import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Agent file frontmatter (requirements §8). `statusLines` is UI-only. In `tools`, `{install}`,
 * `{build}`, `{test}` and `{lint}` expand to the project's commands (dropped when it has none).
 */
export const agentFrontmatter = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  tagline: z.string().min(1),
  avatar: z.string().min(1),
  /** Signature color (hex) for the agent's column, cards and avatar (§13). */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#64748b"),
  column: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(z.string().min(1)),
  /** Where Edit/Write may write (§14): nowhere, anywhere in the worktree, or only the project's test globs. */
  editScope: z.enum(["none", "worktree", "test_globs"]).default("none"),
  /** Bundled plugins from plugins/<name> (§8). Ponytail's level is passed as PONYTAIL_DEFAULT_MODE. */
  plugins: z
    .array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), level: z.string().optional() }))
    .default([]),
  maxTurns: z.number().int().positive(),
  timeoutMinutes: z.number().positive(),
  maxBudgetUsd: z.number().positive(),
  verdicts: z.array(z.enum(["success", "changes_requested", "failed", "needs_input"])).min(1),
  statusLines: z.record(z.string(), z.string()).default({}),
});
export type AgentConfig = z.output<typeof agentFrontmatter> & { prompt: string };

export function parseAgentFile(text: string): AgentConfig {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("Agent file must start with a --- YAML frontmatter block ---");
  const prompt = m[2]!.trim();
  if (!prompt) throw new Error("Agent file has no system prompt after the frontmatter");
  return { ...agentFrontmatter.parse(parse(m[1]!)), prompt };
}

/** Both apps run with their package dir as cwd (as for the root .env), so ../../agents is the repo folder. */
// turbopackIgnore: agent files are runtime data read from disk, not part of the server bundle.
export const agentsDir = () =>
  resolve(/*turbopackIgnore: true*/ process.env.KANBOT_AGENTS_DIR ?? "../../agents");

/** A column whose agent has no file yet behaves as a human gate (no run is queued). */
export const agentFileExists = (slug: string) => existsSync(resolve(agentsDir(), `${slug}.md`));

/**
 * Reads agents/<slug>.md from disk on every call, so edits apply to the next run (FR-30 hot reload).
 * Returns null when there is no file: that column behaves as a human gate until its agent ships.
 * Throws (with the zod message) when the file is invalid.
 */
export function loadAgent(slug: string): AgentConfig | null {
  let text: string;
  try {
    text = readFileSync(resolve(agentsDir(), `${slug}.md`), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const agent = parseAgentFile(text);
  if (agent.slug !== slug) throw new Error(`agents/${slug}.md declares slug "${agent.slug}"`);
  return agent;
}
