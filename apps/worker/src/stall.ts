import { BROWSER_TOOLS, EDIT_TOOLS } from "./runtime/fence";
import type { RuntimeEvent } from "./runtime/types";

/** Stall detection (§8): this many identical tool calls stop a run. */
const STALL_REPEATS = 3;
/** "About 15 turns" with no progress (§8); a turn often makes a few calls. Golden runs peak at 5. */
const NO_PROGRESS_CALLS = 25;

/** Watches a run's events and calls `stop` with the reason when it is stuck. `editor`: the agent may edit files. */
export function stallDetector(editor: boolean, stop: (reason: string) => void) {
  const calls = new Map<string, number>();
  let idle = 0;
  return (e: RuntimeEvent, testCommand?: string) => {
    // Stall detection (§8). Repetition: the same tool call with the same arguments a third time.
    // An edit is progress: rerunning the tests after one is not a loop (refused Testy in the M3 golden run).
    // shortcut: no "repeated feedback" rule yet (M6); the bounce limit bounds those loops meanwhile.
    if (e.type !== "tool_call") return;
    const name = String(e.payload.name);
    const input = e.payload.input as { command?: unknown; method?: unknown } | null;
    const command = String(input?.command ?? "");
    // A request that changes the app's state is progress too: GET, POST, GET again is not a loop.
    const http = name === "mcp__kanbot__http_request";
    // So does clicking or typing in QA's browser: reading the page again after each is checking, not looping
    // (found in the M5 eval: Testy read the heading after adding and after ticking a todo).
    const browser = BROWSER_TOOLS.includes(name);
    const changesApp =
      (http && !["GET", "HEAD", "OPTIONS", undefined].includes(input?.method as string)) ||
      name === "mcp__kanbot__browser_click" ||
      name === "mcp__kanbot__browser_type";
    if (EDIT_TOOLS.has(name) || changesApp) calls.clear();
    else {
      const k = JSON.stringify([name, e.payload.input]);
      const count = (calls.get(k) ?? 0) + 1;
      calls.set(k, count);
      if (count >= STALL_REPEATS)
        stop(`Stopped: the agent made the same ${name} call ${count} times`);
    }
    // No progress: agents that may edit, this many calls with no edit and no test run.
    const progress =
      EDIT_TOOLS.has(name) || http || browser || (!!testCommand && command.includes(testCommand));
    idle = progress ? 0 : idle + 1;
    if (editor && idle >= NO_PROGRESS_CALLS)
      stop(`Stopped: ${idle} tool calls with no file change and no test run`);
  };
}
