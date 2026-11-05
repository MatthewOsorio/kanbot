import { describe, expect, it, vi } from "vitest";
import type { RunRequest } from "../src/runtime/types";

// The SDK sends an error result, then throws (seen with real runs: "Reached maximum budget").
let script: { messages: unknown[]; thenThrow?: Error } = { messages: [] };
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
  getSessionInfo: async () => null,
  query: async function* () {
    for (const m of script.messages) yield m;
    if (script.thenThrow) throw script.thenThrow;
  },
}));

const { SdkRuntime } = await import("../src/runtime/sdk");

const errorResult = {
  type: "result",
  subtype: "error_max_budget_usd",
  session_id: "s-1",
  total_cost_usd: 0.0418,
  modelUsage: {},
  errors: [],
  num_turns: 2,
  duration_ms: 3200,
};
const params = {
  agent: { model: "m", prompt: "p", maxTurns: 5, maxBudgetUsd: 0.03 },
  tools: [],
  canEdit: () => false,
  plugins: [],
  prompt: "go",
  cwd: process.cwd(),
  signal: new AbortController().signal,
} as unknown as RunRequest;
const noEmit = async () => {};

describe("SdkRuntime", () => {
  it("keeps the stop reason and cost when the SDK throws after an error result", async () => {
    script = {
      messages: [errorResult],
      thenThrow: new Error("Claude Code returned an error result: Reached maximum budget ($0.03)"),
    };
    const r = await new SdkRuntime().run(params, noEmit);
    expect(r).toMatchObject({ stop: "budget", costUsd: 0.0418, sessionId: "s-1" });
  });

  it("still throws when the SDK fails before any result", async () => {
    script = { messages: [], thenThrow: new Error("spawn failed") };
    await expect(new SdkRuntime().run(params, noEmit)).rejects.toThrow("spawn failed");
  });
});
