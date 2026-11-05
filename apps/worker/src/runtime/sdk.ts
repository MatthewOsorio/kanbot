import {
  createSdkMcpServer,
  getSessionInfo,
  query,
  tool,
  type HookCallback,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { verdictShape } from "@kanbot/shared";
import { checkToolCall } from "./fence";
import type { AgentRuntime, ApiError, RuntimeEvent, RuntimeResult } from "./types";

const REPORT_TOOL = "mcp__kanbot__report_result";
const MAX_TEXT = 4_000; // per stored event; the full transcript stays in the SDK session

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… [truncated]` : s);
const API_ERRORS: readonly ApiError[] = [
  "rate_limit",
  "overloaded",
  "server_error",
  "authentication_failed",
  "billing_error",
];

/** Claude Agent SDK adapter (requirements §8 step 4). Checked against @anthropic-ai/claude-agent-sdk 0.3.304. */
const BUNDLED_PLUGINS = [
  "cc-plugin-agents-md@builtin",
  "cc-plugin-telemetry@builtin",
  "cc-plugin-plugin-authoring@builtin",
];

export class SdkRuntime implements AgentRuntime {
  async run(
    {
      agent,
      tools,
      canEdit,
      plugins,
      prompt,
      cwd,
      signal,
      env: extraEnv,
      resumeSessionId,
    }: Parameters<AgentRuntime["run"]>[0],
    emit: (e: RuntimeEvent) => Promise<void>,
  ): Promise<RuntimeResult> {
    let report: unknown = null;
    const kanbot = createSdkMcpServer({
      name: "kanbot",
      alwaysLoad: true, // never deferred behind tool search: the agent must see report_result's schema from turn 1
      tools: [
        tool(
          "report_result",
          "Report your final verdict. Call this exactly once, as your last action.",
          verdictShape,
          async (args) => {
            report = args;
            return { content: [{ type: "text", text: "Recorded. End your turn now." }] };
          },
        ),
      ],
    });

    // Every tool call goes through this hook first (§14): tool allowlist, cwd fence, Bash allowlist,
    // edit scope. The SDK auto-runs read-only shell commands (cat, ls, find…) in every permission
    // mode, so the hook, not the SDK's rules, is the fence.
    const fence = { cwd, tools: [...tools, REPORT_TOOL], canEdit };
    const gate: HookCallback = async (input) => {
      const name = "tool_name" in input ? input.tool_name : "";
      const args = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;
      const reason = checkToolCall(name, args ?? {}, fence);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: reason ? "deny" : "allow",
          permissionDecisionReason: reason ?? undefined,
        },
      };
    };

    const abortController = new AbortController();
    const onAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    // The agent never needs our database; DATABASE_URL stays out of its environment. The SDK itself
    // needs the API key, so the subprocesses it starts (Bash, hooks) get credentials scrubbed (§7, §14).
    const { DATABASE_URL: _db, ...base } = process.env;
    // Per-command timeout for the agent's Bash tool: the same 10 minutes as the worker's own install.
    const env = {
      ...base,
      ...extraEnv,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      BASH_DEFAULT_TIMEOUT_MS: "600000",
      BASH_MAX_TIMEOUT_MS: "600000",
    };

    const result: RuntimeResult = {
      report: null,
      stop: "error",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    let apiError: ApiError | undefined;
    try {
      for await (const m of query({
        prompt,
        options: {
          model: agent.model,
          systemPrompt: agent.prompt,
          cwd,
          // Only the frontmatter's built-in tools exist for the agent; the hook still gates every call.
          tools: [...new Set(tools.map((t) => t.replace(/\(.*$/, "")))],
          allowedTools: fence.tools,
          permissionMode: "dontAsk", // anything neither the hook nor allowedTools approves is denied
          hooks: { PreToolUse: [{ hooks: [gate] }] },
          // Second layer behind the hook. blockWrites needs Claude Code 2.1.314; this SDK bundles 2.1.304.
          settings: {
            permissions: { blockReadsOutsideWorkingDirectories: true },
            // Claude Code's bundled plugins; checked on the init message (only our plugins load).
            // shortcut: a fixed list, so a bundled plugin added by a newer SDK loads until it is listed; re-check the init plugins on each SDK upgrade.
            enabledPlugins: Object.fromEntries(BUNDLED_PLUGINS.map((id) => [id, false])),
          },
          plugins: plugins.map((path) => ({ type: "local" as const, path })),
          // Only our plugins' skills; Claude Code's bundled ones (deep-research, design…) showed up in the M3 golden run.
          skills: plugins.flatMap((p) =>
            existsSync(join(p, "skills"))
              ? readdirSync(join(p, "skills")).map((s) => `${basename(p)}:${s}`)
              : [],
          ),
          mcpServers: { kanbot },
          // Sessions are files on this machine, under the cwd; one that is gone means a cold start.
          resume:
            resumeSessionId && (await getSessionInfo(resumeSessionId, { dir: cwd }))
              ? resumeSessionId
              : undefined,
          maxTurns: agent.maxTurns,
          maxBudgetUsd: agent.maxBudgetUsd,
          settingSources: [], // no user or project settings from the host machine
          env,
          abortController,
        },
      })) {
        for (const e of toEvents(m)) await emit(e);
        if (m.type === "assistant" && m.error && API_ERRORS.includes(m.error as ApiError))
          apiError = m.error as ApiError;
        if (m.type === "result") {
          result.sessionId = m.session_id;
          result.costUsd = m.total_cost_usd;
          // `usage` covers only uncached main-loop tokens; modelUsage has every model, cache included.
          const models = Object.values(m.modelUsage);
          result.inputTokens = models.reduce(
            (n, u) => n + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
            0,
          );
          result.outputTokens = models.reduce((n, u) => n + u.outputTokens, 0);
          result.stop =
            m.subtype === "success"
              ? m.is_error && apiError
                ? "api_error"
                : "completed"
              : m.subtype === "error_max_turns"
                ? "max_turns"
                : m.subtype === "error_max_budget_usd"
                  ? "budget"
                  : apiError
                    ? "api_error"
                    : "error";
          if (m.subtype !== "success") result.error = m.errors.join("; ") || m.subtype;
          else if (m.is_error) result.error = m.result;
        }
      }
    } catch (e) {
      // After an error result (max budget, max turns) the SDK also throws "Claude Code returned an error
      // result". The result (only it sets sessionId) already holds the stop reason and the cost, so keep it.
      if (!result.sessionId || signal.aborted) throw e;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    signal.throwIfAborted();
    return { ...result, report, apiError };
  }
}

/** The health probe behind automatic resume (§8): listing models is free and needs a working API. */
export async function anthropicReachable() {
  try {
    await new Anthropic({ maxRetries: 0, timeout: 10_000 }).models.list({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

/** Maps SDK messages to the run_event types the Live tab shows; everything else is dropped. */
function toEvents(m: SDKMessage): RuntimeEvent[] {
  if (m.type === "system" && m.subtype === "init")
    return [
      {
        type: "system",
        payload: {
          subtype: "init",
          model: m.model,
          sessionId: m.session_id, // kept on the run even if it is stopped, for Resume (§8)
          tools: m.tools,
          plugins: m.plugins.map((p) => p.name), // proves a plugin actually loaded
          skills: m.skills,
        },
      },
    ];
  if (m.type === "system" && m.subtype === "api_retry")
    return [
      {
        type: "system",
        payload: {
          subtype: "api_retry",
          attempt: m.attempt,
          max_retries: m.max_retries,
          error: m.error,
          retry_delay_ms: m.retry_delay_ms,
        },
      },
    ];
  if (m.type === "assistant")
    return m.message.content.flatMap((b): RuntimeEvent[] =>
      b.type === "text"
        ? [{ type: "assistant", payload: { text: clip(b.text) } }]
        : b.type === "tool_use"
          ? [{ type: "tool_call", payload: { id: b.id, name: b.name, input: b.input } }]
          : [],
    );
  if (m.type === "user" && Array.isArray(m.message.content))
    return m.message.content.flatMap((b): RuntimeEvent[] =>
      b.type === "tool_result"
        ? [
            {
              type: "tool_result",
              payload: {
                toolUseId: b.tool_use_id,
                isError: !!b.is_error,
                content: clip(
                  typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
                ),
              },
            },
          ]
        : [],
    );
  if (m.type === "result")
    return [
      {
        type: "system",
        payload: {
          subtype: "result",
          result: m.subtype,
          turns: m.num_turns,
          costUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
        },
      },
    ];
  return [];
}
