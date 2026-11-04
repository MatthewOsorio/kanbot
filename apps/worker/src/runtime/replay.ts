import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { runEventTypes, uuidv7 } from "@kanbot/shared";
import { git } from "@kanbot/shared/repo";
import type { AgentRuntime, RuntimeEvent, RuntimeResult } from "./types";

/**
 * A scripted run (requirements §8 "Testing without real agents"), stored as
 * fixtures/runs/<agent>/<scenario>.<n>.json for the agent's nth run on the ticket, else <scenario>.json.
 * Recorded runs (KANBOT_RECORD=1) are written in this same format.
 */
const script = z.object({
  events: z
    .array(
      z.object({
        type: z.enum(runEventTypes),
        payload: z.record(z.string(), z.unknown()),
        delayMs: z.number().int().min(0).default(0),
      }),
    )
    .default([]),
  /** Emits this many `api_retry` system events first, as the SDK does while it retries 429/5xx. */
  apiRetries: z.number().int().min(0).default(0),
  stop: z.enum(["completed", "max_turns", "budget", "api_error", "error"]).default("completed"),
  apiError: z
    .enum([
      "rate_limit",
      "overloaded",
      "server_error",
      "authentication_failed",
      "billing_error",
      "unknown",
    ])
    .optional(),
  error: z.string().optional(),
  report: z.unknown().default(null),
  costUsd: z.number().default(0),
  inputTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  /** A git patch the replay applies and commits in the run's cwd, so diffs and checks are real. */
  patch: z.string().optional(),
  commitMessage: z.string().default("Replay commit"),
});

export const fixturesDir = () => resolve(process.env.KANBOT_FIXTURES_DIR ?? "../../fixtures/runs");

// Replay commits need an identity even where git has none configured (CI).
const IDENTITY = ["-c", "user.name=Kanbot replay", "-c", "user.email=replay@kanbot.local"];

export class ReplayRuntime implements AgentRuntime {
  async run(
    { agent, scenario, attempt, cwd, signal, prompt }: Parameters<AgentRuntime["run"]>[0],
    emit: Parameters<AgentRuntime["run"]>[1],
  ): Promise<RuntimeResult> {
    // An agent with no script for this scenario plays its default (e.g. golden tickets not recorded yet).
    const file = [`${scenario}.${attempt}`, scenario, "default"]
      .map((name) => resolve(fixturesDir(), agent.slug, `${name}.json`))
      .find((f) => existsSync(f));
    if (!file) throw new Error(`No replay script for ${agent.slug}/${scenario} and no default`);
    const s = script.parse(JSON.parse(await readFile(file, "utf8")));
    await emit({
      type: "system",
      payload: { subtype: "init", model: agent.model, replay: scenario },
    });
    for (let i = 1; i <= s.apiRetries; i++) {
      signal.throwIfAborted();
      await emit({
        type: "system",
        payload: {
          subtype: "api_retry",
          attempt: i,
          max_retries: s.apiRetries,
          error: "rate_limit",
        },
      });
    }
    for (const e of s.events) {
      if (e.delayMs) await sleep(e.delayMs, undefined, { signal });
      signal.throwIfAborted();
      await emit({ type: e.type, payload: e.payload });
    }
    signal.throwIfAborted();
    if (s.patch) {
      const tmp = join(tmpdir(), `kanbot-replay-${uuidv7()}.patch`);
      await writeFile(tmp, s.patch);
      try {
        await git(cwd, ["apply", "--index", tmp]);
        await git(cwd, [...IDENTITY, "commit", "-m", s.commitMessage]);
      } finally {
        await rm(tmp, { force: true });
      }
    }
    return {
      report: withCriterionIds(s.report, prompt),
      stop: s.stop,
      apiError: s.apiError,
      error: s.error,
      sessionId: `replay-${scenario}`,
      costUsd: s.costUsd,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
    };
  }
}

/** Criterion ids in the run's context, in order (`id="…"` in <acceptance_criteria>). */
const criterionIds = (prompt: string) =>
  [...prompt.matchAll(/\(id="([0-9a-f-]{36})"/g)].map((m) => m[1]!);

/**
 * Scripts can't know the database's ids, so they name criteria `$criterion1`, `$criterion2`… by
 * position. Replay swaps in this run's ids; recording swaps them back out.
 */
function withCriterionIds(report: unknown, prompt: string): unknown {
  const ids = criterionIds(prompt);
  return JSON.parse(
    JSON.stringify(report).replace(/\$criterion(\d+)/g, (m, n: string) => ids[Number(n) - 1] ?? m),
  );
}

const secret = process.env.ANTHROPIC_API_KEY;
/** Secrets never reach stored run events or recorded scripts (requirements §14). */
export const redactText = (s: string) =>
  secret && secret.length >= 8 ? s.replaceAll(secret, "[redacted]") : s;

/**
 * Saves a real run as a replay script (requirements §8 recorded runs, KANBOT_RECORD=1): its events,
 * report and usage, plus what it committed as one patch. Secrets are redacted like stored events.
 */
export async function record(
  slug: string,
  scenario: string,
  attempt: number,
  events: RuntimeEvent[],
  result: RuntimeResult,
  wt: { path: string; base: string } | null,
  prompt: string,
  cwd: string,
) {
  const commits = wt ? (await git(wt.path, ["rev-list", `${wt.base}..HEAD`])).trim() : "";
  const out = {
    events,
    stop: result.stop,
    apiError: result.apiError,
    error: result.error,
    report: result.report,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    ...(wt &&
      commits && {
        patch: await git(wt.path, ["diff", "--binary", wt.base, "HEAD"]),
        commitMessage: (await git(wt.path, ["log", "-1", "--format=%B"])).trim(),
      }),
  };
  // The run's folder (a temp path with the host's user name) becomes <cwd>; scripts are committed.
  let text = JSON.stringify(out, null, 2)
    .replaceAll(JSON.stringify(cwd).slice(1, -1), "<cwd>")
    .replaceAll(JSON.stringify(cwd.replaceAll("\\", "/")).slice(1, -1), "<cwd>");
  criterionIds(prompt).forEach((id, i) => (text = text.replaceAll(id, `$criterion${i + 1}`)));
  text = redactText(text);
  const file = resolve(fixturesDir(), slug, `${scenario}.${attempt}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${text}\n`);
}
