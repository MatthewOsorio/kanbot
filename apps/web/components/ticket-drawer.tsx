"use client";

import { activeRunStates, priorities, ticketTypes, type BoardEvent } from "@kanbot/shared";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import type { TicketDetail } from "@/lib/tickets";

type Comment = {
  id: string;
  bodyMd: string;
  createdAt: string;
  authorKind: "user" | "agent";
  agentSlug: string | null;
  file: string | null;
  line: number | null;
  resolved: boolean;
};
type Activity = {
  id: string;
  actor: string;
  action: string;
  data: Record<string, unknown>;
  createdAt: string;
};
type Run = TicketDetail["runs"][number];
type RunEvent = { seq: number; type: string; payload: Record<string, unknown>; createdAt: string };

const statusMark = { open: "○ open", pass: "✓ pass", fail: "✗ fail" } as const;
const isActive = (r: Run | undefined) =>
  !!r && (activeRunStates as readonly string[]).includes(r.state);
const RETRYABLE = ["failed", "interrupted", "timed_out", "budget_exceeded", "cancelled"];

export function TicketDrawer(props: {
  ticketId: string | null;
  lastEvent: BoardEvent | null;
  onClose: () => void;
}) {
  const { ticketId, lastEvent, onClose } = props;
  const [data, setData] = useState<{
    ticket: TicketDetail;
    comments: Comment[];
    activity: Activity[];
  } | null>(null);
  const [error, setError] = useState("");
  const { ticket, comments, activity } = data ?? { ticket: null, comments: [], activity: [] };
  // Live: refetch whenever this ticket changes in any tab. The board remounts us per ticket (key).
  // Log lines (run.event) are fetched by the Live tab alone.
  const forUs = lastEvent && "ticketId" in lastEvent && lastEvent.ticketId === ticketId;
  const change = forUs && lastEvent.type !== "run.event" ? lastEvent : null;
  const runEvent = forUs && lastEvent.type === "run.event" ? lastEvent : null;

  useEffect(() => {
    if (!ticketId) return;
    if (change?.type === "ticket.deleted") return onClose();
    let stale = false;
    Promise.all([
      api<TicketDetail>(`/api/tickets/${ticketId}`),
      api<Comment[]>(`/api/tickets/${ticketId}/comments`),
      api<Activity[]>(`/api/tickets/${ticketId}/activity`),
    ]).then(
      ([ticket, comments, activity]) => !stale && setData({ ticket, comments, activity }),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [ticketId, change, onClose]);

  async function run(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const patch = (body: Record<string, unknown>) =>
    run(() => api(`/api/tickets/${ticketId}`, { method: "PATCH", body }));
  const latest = ticket?.runs[0];

  return (
    <Sheet open={!!ticketId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {!ticket ? (
          <SheetHeader>
            <SheetTitle>{error || "Loading…"}</SheetTitle>
            <SheetDescription className="sr-only">Ticket details</SheetDescription>
          </SheetHeader>
        ) : (
          <div className="space-y-6 p-4">
            <SheetHeader className="p-0">
              <SheetDescription className="pr-8">
                {ticket.key} · {ticket.columnName}
                {ticket.branchName && (
                  <>
                    {" "}
                    · <code>{ticket.branchName}</code>
                  </>
                )}
                {ticket.bounceCount > 0 && (
                  <>
                    {" "}
                    · ↩ {ticket.bounceCount} bounce{ticket.bounceCount > 1 && "s"}
                  </>
                )}
              </SheetDescription>
              <SheetTitle className="sr-only">{ticket.title}</SheetTitle>
              <Input
                key={ticket.title} // remount so another tab's edit shows up
                aria-label="Title"
                defaultValue={ticket.title}
                className="text-lg font-semibold"
                onBlur={(e) => e.target.value !== ticket.title && patch({ title: e.target.value })}
              />
            </SheetHeader>

            {latest && (
              <RunBar
                run={latest}
                onCancel={() => run(() => api(`/api/runs/${latest.id}/cancel`, { method: "POST" }))}
                onRetry={() => run(() => api(`/api/runs/${latest.id}/retry`, { method: "POST" }))}
              />
            )}

            {ticket.columnSlug === "planning" &&
              ticket.artifacts.some((a) => a.kind === "plan") &&
              !isActive(latest) && (
                // The same as dropping the ticket on Ready (UC-4).
                <Button
                  size="sm"
                  onClick={() =>
                    run(() => api(`/api/tickets/${ticket.id}/approve-plan`, { method: "POST" }))
                  }
                >
                  Approve plan
                </Button>
              )}

            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-1">
                Type
                <select
                  className="rounded-md border bg-background px-2 py-1"
                  value={ticket.type}
                  onChange={(e) => patch({ type: e.target.value })}
                >
                  {ticketTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                Priority
                <select
                  className="rounded-md border bg-background px-2 py-1"
                  value={ticket.priority}
                  onChange={(e) => patch({ priority: e.target.value })}
                >
                  {priorities.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-1 items-center gap-1">
                Labels
                <Input
                  key={ticket.labels.join()}
                  defaultValue={ticket.labels.join(", ")}
                  placeholder="comma, separated"
                  onBlur={(e) => {
                    const labels = e.target.value
                      .split(",")
                      .map((l) => l.trim())
                      .filter(Boolean);
                    if (labels.join() !== ticket.labels.join()) void patch({ labels });
                  }}
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Description</span>
              <Textarea
                key={ticket.descriptionMd}
                defaultValue={ticket.descriptionMd}
                rows={6}
                onBlur={(e) =>
                  e.target.value !== ticket.descriptionMd &&
                  patch({ descriptionMd: e.target.value })
                }
              />
            </label>
            {ticket.descriptionMd && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Preview</summary>
                <Markdown>{ticket.descriptionMd}</Markdown>
              </details>
            )}

            <section aria-labelledby="ac-h" className="space-y-2">
              <h3 id="ac-h" className="text-sm font-medium">
                Acceptance criteria
              </h3>
              <ul className="space-y-1">
                {ticket.criteria.map((c) => (
                  <li key={c.id + c.text} className="flex items-center gap-2 text-sm">
                    <span className="w-14 shrink-0 text-muted-foreground">
                      {statusMark[c.status]}
                    </span>
                    <Input
                      aria-label="Criterion"
                      defaultValue={c.text}
                      onBlur={(e) =>
                        e.target.value !== c.text &&
                        run(() =>
                          api(`/api/criteria/${c.id}`, {
                            method: "PATCH",
                            body: { text: e.target.value },
                          }),
                        )
                      }
                    />
                    {c.source === "agent" && (
                      <span className="shrink-0 text-xs text-muted-foreground">from plan</span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove criterion: ${c.text}`}
                      onClick={() => run(() => api(`/api/criteria/${c.id}`, { method: "DELETE" }))}
                    >
                      ✕
                    </Button>
                  </li>
                ))}
              </ul>
              <form
                action={(f) =>
                  run(() =>
                    api(`/api/tickets/${ticket.id}/criteria`, { body: { text: f.get("text") } }),
                  )
                }
              >
                <Input
                  name="text"
                  required
                  aria-label="New criterion"
                  placeholder="Add a criterion…"
                />
              </form>
            </section>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Tabs defaultValue={isActive(latest) ? "live" : "activity"}>
              <TabsList>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="live">Live</TabsTrigger>
                <TabsTrigger value="artifacts">Artifacts ({ticket.artifacts.length})</TabsTrigger>
                <TabsTrigger value="diff">Diff</TabsTrigger>
                <TabsTrigger value="comments">Comments ({comments.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="activity">
                <ol className="space-y-1 text-sm">
                  {activity.map((a) => (
                    <li key={a.id}>
                      <span className="text-muted-foreground">
                        {new Date(a.createdAt).toLocaleString()}
                      </span>{" "}
                      {a.actor} {describe(a)}
                    </li>
                  ))}
                </ol>
              </TabsContent>

              <TabsContent value="live">
                {latest ? (
                  <LiveLog
                    key={latest.id}
                    runId={latest.id}
                    lastSeq={runEvent?.runId === latest.id ? runEvent.seq : 0}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No agent has run on this ticket.</p>
                )}
              </TabsContent>

              <TabsContent value="artifacts" className="space-y-4">
                {ticket.artifacts.length === 0 && (
                  <p className="text-sm text-muted-foreground">No artifacts yet.</p>
                )}
                {ticket.columnSlug === "planning" &&
                  ticket.artifacts.some((a) => a.kind === "plan") && (
                    // Separate from comments: this re-runs Plan B at once with the request (UC-3).
                    <form
                      className="space-y-2"
                      action={(f) =>
                        run(() =>
                          api(`/api/tickets/${ticket.id}/revise-plan`, {
                            body: { requestMd: f.get("requestMd") },
                          }),
                        )
                      }
                    >
                      <Textarea
                        name="requestMd"
                        required
                        aria-label="Requested plan changes"
                        placeholder="What should change in the plan?"
                        rows={2}
                        disabled={isActive(latest)}
                      />
                      <Button type="submit" size="sm" disabled={isActive(latest)}>
                        Revise plan
                      </Button>
                    </form>
                  )}
                {ticket.artifacts.map((a, i) =>
                  i === ticket.artifacts.findIndex((b) => b.kind === a.kind) ? (
                    <article
                      key={a.id}
                      aria-label={`${a.title} v${a.version}`}
                      className="rounded-md border p-3"
                    >
                      <h3 className="text-sm font-semibold">
                        {a.title} <span className="text-muted-foreground">v{a.version}</span>
                      </h3>
                      <Markdown>{a.contentMd}</Markdown>
                    </article>
                  ) : (
                    // Older versions are kept (UC-3); collapsed under the latest.
                    <details key={a.id} className="rounded-md border p-3 text-sm">
                      <summary className="cursor-pointer">
                        {a.title} v{a.version} · {new Date(a.createdAt).toLocaleString()}
                      </summary>
                      <Markdown>{a.contentMd}</Markdown>
                    </details>
                  ),
                )}
              </TabsContent>

              <TabsContent value="diff">
                <DiffView ticketId={ticket.id} refresh={change} />
              </TabsContent>

              <TabsContent value="comments" className="space-y-2">
                <ul className="space-y-2">
                  {comments.map((c) => (
                    <li key={c.id} className="rounded-md border p-2 text-sm">
                      <CommentByline c={c} />
                      <Markdown>{c.bodyMd}</Markdown>
                      <time className="text-xs text-muted-foreground">
                        {new Date(c.createdAt).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ul>
                <form
                  className="space-y-2"
                  action={(f) =>
                    run(() =>
                      api(`/api/tickets/${ticket.id}/comments`, {
                        body: { bodyMd: f.get("bodyMd") },
                      }),
                    )
                  }
                >
                  <Textarea name="bodyMd" required aria-label="New comment" rows={2} />
                  <Button type="submit" size="sm">
                    Comment
                  </Button>
                </form>
              </TabsContent>
            </Tabs>

            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                confirm(`Delete ${ticket.key}? This can't be undone.`) &&
                run(async () => {
                  await api(`/api/tickets/${ticket.id}`, { method: "DELETE" });
                  onClose();
                })
              }
            >
              Delete ticket
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Latest run: agent, state, elapsed time, cost, and the Cancel / Retry actions (FR-35). */
function RunBar({
  run,
  onCancel,
  onRetry,
}: {
  run: Run;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const active = isActive(run);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  const start = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
  const secs = start ? Math.max(0, Math.round((end - start) / 1000)) : 0;
  return (
    <section aria-label="Latest run" className="space-y-1 rounded-md border p-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          <strong>{run.agentSlug}</strong> · {run.state.replace("_", " ")}
          {start && ` · ${Math.floor(secs / 60)}m ${secs % 60}s`}
          {/* shortcut: the SDK reports cost only when a run ends, so a running run shows none; M4 cost tracking can sum per-turn usage. */}
          {!active && ` · $${run.costUsd.toFixed(2)}`}
        </span>
        {active && (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel run
          </Button>
        )}
        {RETRYABLE.includes(run.state) && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
      {run.summary && <p>{run.summary}</p>}
      {run.error && <p className="text-destructive">{run.error}</p>}
    </section>
  );
}

/** Live tab (UC-8): pages the stored log, then fetches what's new on each run.event. */
function LiveLog({ runId, lastSeq }: { runId: string; lastSeq: number }) {
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
    <ol aria-label="Run log" className="space-y-1 font-mono text-xs">
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
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2">
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

function describe(a: Activity): string {
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
      return d.request
        ? `requested plan changes: "${String(d.request)}"`
        : `started ${String(d.agent)}`;
    case "run_finished":
      return `finished ${String(d.agent)}: ${String(d.state).replace("_", " ")}${d.error ? ` (${String(d.error)})` : ""}${d.bounce ? `, bounce ${String(d.bounce)}` : ""}${d.reason ? `. ${String(d.reason)}` : ""}`;
    default:
      return a.action;
  }
}

/** Who wrote a comment: the agent (avatar + name) or the owner, plus file:line for review comments. */
function CommentByline({ c }: { c: Comment }) {
  return (
    <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
      {c.agentSlug ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- tiny local SVG */}
          <img src={`/api/agents/${c.agentSlug}/avatar`} alt="" className="size-4 rounded-full" />
          <span>{c.agentSlug}</span>
        </>
      ) : (
        <span>owner</span>
      )}
      {c.file && (
        <code>
          {c.file}
          {c.line ? `:${c.line}` : ""}
        </code>
      )}
      {c.resolved && <span>· resolved</span>}
    </p>
  );
}

type Diff = {
  branch: string | null;
  base: string;
  diff: string;
  truncated: boolean;
  comments: Comment[];
};

/**
 * The branch diff vs the default branch (FR-41), unified, with review comments under their line.
 * shortcut: unified only; the spec's side-by-side view is M6 polish.
 */
function DiffView({ ticketId, refresh }: { ticketId: string; refresh: unknown }) {
  const [d, setD] = useState<Diff | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false;
    api<Diff>(`/api/tickets/${ticketId}/diff`).then(
      (x) => !stale && setD(x),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [ticketId, refresh]);
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!d.branch)
    return (
      <p className="text-sm text-muted-foreground">
        No branch yet: one is created when the ticket enters In Progress.
      </p>
    );
  if (!d.diff)
    return (
      <p className="text-sm text-muted-foreground">
        {d.branch} has no changes against {d.base}.
      </p>
    );

  return (
    <div
      aria-label={`Diff of ${d.branch} against ${d.base}`}
      className="overflow-x-auto font-mono text-xs"
    >
      {diffRows(d.diff, d.comments).map((r, i) => (
        <div key={i}>
          <div className={`whitespace-pre ${r.cls}`}>{r.text || " "}</div>
          {r.notes.map((c) => (
            <div
              key={c.id}
              role="note"
              className="my-1 whitespace-normal rounded border bg-background p-2 font-sans"
            >
              <CommentByline c={c} />
              <Markdown>{c.bodyMd}</Markdown>
            </div>
          ))}
        </div>
      ))}
      {d.truncated && <p className="font-sans text-muted-foreground">Diff truncated at 1 MB.</p>}
    </div>
  );
}

/** Splits a unified diff into styled lines, attaching each review comment under its new-file line. */
function diffRows(diff: string, comments: Comment[]) {
  let file = "";
  let line = 0;
  let inHunk = false;
  return diff.split("\n").map((text) => {
    let at: number | null = null;
    if (text.startsWith("diff ")) inHunk = false;
    else if (text.startsWith("+++ ")) file = text.slice(4).replace(/^b\//, "");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      inHunk = true;
    } else if (inHunk && (text.startsWith("+") || text.startsWith(" "))) at = ++line;
    const cls =
      inHunk && text.startsWith("+")
        ? "bg-green-50 text-green-900"
        : inHunk && text.startsWith("-")
          ? "bg-red-50 text-red-900"
          : !inHunk || hunk
            ? "text-muted-foreground"
            : "";
    const notes = at === null ? [] : comments.filter((c) => c.file === file && c.line === at);
    return { text, cls, notes };
  });
}
