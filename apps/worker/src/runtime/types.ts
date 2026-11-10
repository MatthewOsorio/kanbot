import type { AgentConfig } from "@kanbot/shared/server";
import type { RunEventType } from "@kanbot/shared";

/** One entry in the run's live log (stored as a run_event). */
export type RuntimeEvent = { type: RunEventType; payload: Record<string, unknown> };

export type RunRequest = {
  agent: AgentConfig;
  /** The agent's tools with `{test}`-style placeholders expanded from the project's commands. */
  tools: string[];
  /** Repo-relative path → may Edit/Write touch it (requirements §14 edit scope). Absent = anywhere in cwd. */
  canEdit?: (rel: string) => boolean;
  /** Absolute plugin folders to load (requirements §8 plugins). */
  plugins: string[];
  /** Extra environment for the agent (e.g. PONYTAIL_DEFAULT_MODE). */
  env: Record<string, string>;
  prompt: string; // the assembled context bundle
  cwd: string;
  signal: AbortSignal; // aborted on cancel or timeout
  scenario: string; // replay only: which fixture to play (ticket label `replay:<name>`, else "default")
  attempt: number; // this agent's nth run on the ticket (1-based); replay picks <scenario>.<n>.json
  /** QA runs: the app the worker started; the agent gets `http_request` and the browser tools, limited to it (§4). */
  appUrl?: string;
  /** Stores a browser screenshot on the ticket (§4). */
  saveScreenshot?: (name: string, png: Buffer) => Promise<void>;
  /** Rewrites a Bash command before it runs (project commands into the project's image, §7); null = unchanged. */
  bash?: (command: string) => string | null;
  /** Continue this agent session instead of starting cold (Resume, bounce-backs; FR-35). */
  resumeSessionId?: string;
};

/** API errors that end a run (requirements §8 failure handling). */
export type ApiError =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "authentication_failed"
  | "billing_error"
  | "unknown";

export type RuntimeResult = {
  /** Raw `report_result` input; the worker validates it. null = the agent never called it. */
  report: unknown;
  stop: "completed" | "max_turns" | "budget" | "api_error" | "error";
  error?: string;
  apiError?: ApiError;
  sessionId?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};

/** FR-38: the worker runs every agent through this, so tests swap in the replay runtime. */
export interface AgentRuntime {
  /** Throws an AbortError when `signal` aborts. */
  run(req: RunRequest, emit: (e: RuntimeEvent) => Promise<void>): Promise<RuntimeResult>;
}
