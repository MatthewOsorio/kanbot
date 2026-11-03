import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { runEventTypes } from "@kanbot/shared";
import type { AgentRuntime, RuntimeResult } from "./types";

/** A scripted run (requirements §8 "Testing without real agents"), stored as fixtures/runs/<agent>/<scenario>.json. */
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
});

export const fixturesDir = () => resolve(process.env.KANBOT_FIXTURES_DIR ?? "../../fixtures/runs");

export class ReplayRuntime implements AgentRuntime {
  async run(
    { agent, scenario, signal }: Parameters<AgentRuntime["run"]>[0],
    emit: Parameters<AgentRuntime["run"]>[1],
  ): Promise<RuntimeResult> {
    const file = resolve(fixturesDir(), agent.slug, `${scenario}.json`);
    const s = script.parse(JSON.parse(await readFile(file, "utf8")));
    await emit({
      type: "system",
      payload: { subtype: "init", model: agent.model, replay: scenario },
    });
    for (let attempt = 1; attempt <= s.apiRetries; attempt++) {
      signal.throwIfAborted();
      await emit({
        type: "system",
        payload: { subtype: "api_retry", attempt, max_retries: s.apiRetries, error: "rate_limit" },
      });
    }
    for (const e of s.events) {
      if (e.delayMs) await sleep(e.delayMs, undefined, { signal });
      signal.throwIfAborted();
      await emit({ type: e.type, payload: e.payload });
    }
    signal.throwIfAborted();
    return {
      report: s.report,
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
