"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";

export type Activity = {
  id: string;
  actor: string;
  action: string;
  data: Record<string, unknown>;
  createdAt: string;
};

type RunEvent = { seq: number; type: string; payload: Record<string, unknown>; createdAt: string };

/** Live tab (UC-8): pages the stored log, then fetches what's new on each run.event. */
export function LiveLog({ runId, lastSeq }: { runId: string; lastSeq: number }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const have = events.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (lastSeq && lastSeq <= have) return;
    let stale = false;
    api<RunEvent[]>(`/api/runs/${runId}/events?after=${have}`).then(
      (more) =>
        !stale &&
        more.length &&
        setEvents((e) => [...e, ...more.filter((m) => m.seq > (e.at(-1)?.seq ?? 0))]),
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [runId, lastSeq, have]);
  if (!events.length)
    return <p className="text-sm text-muted-foreground">Waiting for the agent…</p>;
  return (
    <ol
      aria-label="Run log"
      className="space-y-1.5 rounded-lg border bg-surface p-3 font-mono text-xs leading-relaxed"
    >
      {events.map((e) => (
        <li key={e.seq}>
          <LogLine event={e} />
        </li>
      ))}
    </ol>
  );
}

function LogLine({ event: { type, payload } }: { event: RunEvent }) {
  if (type === "assistant")
    return <p className="whitespace-pre-wrap font-sans text-sm">{String(payload.text)}</p>;
  if (type === "tool_call" || type === "tool_result")
    return (
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          {type === "tool_call"
            ? `→ ${String(payload.name)}`
            : `← result${payload.isError ? " (error)" : ""}`}
        </summary>
        <pre className="mt-1 overflow-x-auto rounded-md border bg-background p-2 whitespace-pre-wrap">
          {type === "tool_call" ? JSON.stringify(payload.input, null, 2) : String(payload.content)}
        </pre>
      </details>
    );
  const p = payload as Record<string, string | number>;
  const text =
    p.subtype === "api_retry"
      ? `waiting on API (${p.error}), retry ${p.attempt}/${p.max_retries}`
      : p.subtype === "result"
        ? `finished: ${p.result}, ${p.turns ?? "?"} turns`
        : p.subtype === "init"
          ? `started on ${p.model}`
          : JSON.stringify(payload);
  return <p className="text-muted-foreground">· {text}</p>;
}

export function describe(a: Activity): string {
  const d = a.data;
  switch (a.action) {
    case "created":
      return "created the ticket";
    case "moved":
      return `moved it from ${String(d.from)} to ${String(d.to)}`;
    case "commented":
      return "commented";
    case "edited":
      if (d.change === "replaced by plan") return `wrote ${String(d.count)} acceptance criteria`;
      if (d.change === "checked by QA")
        return `checked ${(d.results as unknown[]).length} acceptance criteria`;
      return d.change
        ? `${String(d.change)} criterion "${String(d.text)}"`
        : `edited ${(d.fields as string[]).join(", ")}`;
    case "run_started":
      if (d.resumed)
        return `resumed ${String(d.agent)}${d.request ? ` with the answer "${String(d.request)}"` : ""}`;
      return d.request
        ? `requested plan changes: "${String(d.request)}"`
        : `started ${String(d.agent)}`;
    case "run_finished":
      return `finished ${String(d.agent)}: ${String(d.state).replace("_", " ")}${d.error ? ` (${String(d.error)})` : ""}${d.bounce ? `, bounce ${String(d.bounce)}` : ""}${d.reason ? `. ${String(d.reason)}` : ""}`;
    case "pr_opened":
      return `${d.updated ? "updated" : "opened"} PR #${String(d.number)}`;
    case "pr_closed":
      return `closed PR #${String(d.number)} without merging`;
    case "pr_merged":
      return `merged PR #${String(d.number)}`;
    case "ci_changed":
      return `CI ${String(d.to) === "none" ? "isn't set up (no workflows)" : String(d.to)}${d.check ? `: ${String(d.check)}` : ""}`;
    case "review_imported":
      return `@${String(d.by)} requested changes (${String(d.comments)} comment${d.comments === 1 ? "" : "s"} imported)`;
    case "pushed":
      return d.rebasedOnto
        ? `was rebased onto ${String(d.rebasedOnto)} (new head ${String(d.sha).slice(0, 7)})`
        : `has a new head ${String(d.sha).slice(0, 7)} pushed outside Kanbot`;
    default:
      return a.action;
  }
}
