"use client";

import { QA_SETUP_MESSAGE } from "@kanbot/shared/onboarding";
import {
  activeRunStates,
  priorities,
  resumableRunStates,
  ticketTypes,
  type BoardEvent,
} from "@kanbot/shared";
import { GitBranch, GitPullRequest, Layers, Loader2 } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { SELECT } from "@/components/brand";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import type { TicketDetail } from "@/lib/tickets";

/** Section heading and header chip styles shared across the drawer. */
const H = "block text-xs font-semibold tracking-wide text-muted-foreground uppercase";
const CHIP = "inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-0.5";

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

/** The board's agents by slug (name, color), so everything an agent made says who made it. */
type AgentInfo = { name: string; color: string };
const Agents = createContext<Record<string, AgentInfo>>({});

/** An agent's avatar and name; the slug when its file is gone. */
function AgentTag({ slug, className = "" }: { slug: string; className?: string }) {
  const a = useContext(Agents)[slug];
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny local SVG */}
      <img src={`/api/agents/${slug}/avatar`} alt="" className="size-4 rounded-full" />
      <span className="text-foreground">{a?.name ?? slug}</span>
    </span>
  );
}

export function TicketDrawer(props: {
  ticketId: string | null;
  lastEvent: BoardEvent | null;
  onClose: () => void;
  agents: Record<string, AgentInfo>;
}) {
  const { ticketId, lastEvent, onClose, agents } = props;
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
    <Agents.Provider value={agents}>
      <Dialog open={!!ticketId} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="block max-h-[85vh] overflow-y-auto p-0 sm:max-w-[min(48rem,calc(100%-2rem))]">
          {!ticket ? (
            <DialogHeader className="p-5 text-left">
              <DialogTitle>{error || "Loading…"}</DialogTitle>
              <DialogDescription className="sr-only">Ticket details</DialogDescription>
            </DialogHeader>
          ) : (
            <div className="space-y-6 p-5">
              <DialogHeader className="gap-2 p-0 text-left">
                <DialogDescription className="flex flex-wrap items-center gap-1.5 pr-8 text-xs">
                  <span className={CHIP + " font-mono font-medium text-foreground"}>
                    {ticket.key} · {ticket.columnName}
                  </span>
                  {ticket.branchName && (
                    <code className={CHIP + " font-mono"}>
                      <GitBranch aria-hidden className="size-3" />
                      {ticket.branchName}
                    </code>
                  )}
                  {ticket.prUrl && (
                    <a
                      href={ticket.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={CHIP + " text-foreground underline-offset-2 hover:underline"}
                    >
                      <GitPullRequest aria-hidden className="size-3" />
                      PR #{ticket.prNumber} on GitHub
                    </a>
                  )}
                  {ticket.bounceCount > 0 && (
                    <span className={CHIP}>
                      ↩ {ticket.bounceCount} bounce{ticket.bounceCount > 1 && "s"}
                    </span>
                  )}
                  {ticket.parent && (
                    <span className={CHIP}>
                      <Layers aria-hidden className="size-3" />
                      part of {ticket.parent.key} {ticket.parent.title}
                    </span>
                  )}
                  {ticket.costUsd > 0 && (
                    <span className={CHIP + " font-mono"}>
                      Cost so far ${ticket.costUsd.toFixed(2)}
                    </span>
                  )}
                </DialogDescription>
                <DialogTitle className="sr-only">{ticket.title}</DialogTitle>
                <Input
                  key={ticket.title} // remount so another tab's edit shows up
                  aria-label="Title"
                  defaultValue={ticket.title}
                  className="-mx-2 h-auto border-transparent bg-transparent px-2 py-1 text-xl font-semibold shadow-none hover:border-input md:text-xl dark:bg-transparent"
                  onBlur={(e) =>
                    e.target.value !== ticket.title && patch({ title: e.target.value })
                  }
                />
              </DialogHeader>

              {latest && (
                <RunBar
                  run={latest}
                  onCancel={() =>
                    run(() => api(`/api/runs/${latest.id}/cancel`, { method: "POST" }))
                  }
                  onRetry={() => run(() => api(`/api/runs/${latest.id}/retry`, { method: "POST" }))}
                />
              )}

              {ticket.columnSlug === "blocked" && (
                <BlockedPanel
                  key={ticket.runs.find((r) => r.columnSlug !== "blocked")?.id} // a new stuck run clears the answer
                  ticket={ticket}
                  onResume={(runId, answer) =>
                    run(() =>
                      api(`/api/runs/${runId}/resume`, { method: "POST", body: { answer } }),
                    )
                  }
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

              {ticket.columnSlug === "code_review" && ticket.statusFlag === "needs_input" && (
                // finish() held it here: no start command for QA (§4).
                <p className="rounded-md bg-needs px-3 py-2 text-sm text-needs-fg">
                  {QA_SETUP_MESSAGE}, then drag the ticket to QA.
                </p>
              )}

              {ticket.columnSlug === "qa" &&
                ticket.statusFlag === "awaiting_approval" &&
                !isActive(latest) && (
                  // The same as dropping the ticket on Ship (§3: QA's approval gate).
                  <Button
                    size="sm"
                    onClick={() =>
                      run(() => api(`/api/tickets/${ticket.id}/approve-ship`, { method: "POST" }))
                    }
                  >
                    Approve and ship
                  </Button>
                )}

              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2 text-muted-foreground">
                  Type
                  <select
                    className={SELECT + " text-foreground"}
                    value={ticket.type}
                    onChange={(e) => patch({ type: e.target.value })}
                  >
                    {ticketTypes.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-muted-foreground">
                  Priority
                  <select
                    className={SELECT + " text-foreground"}
                    value={ticket.priority}
                    onChange={(e) => patch({ priority: e.target.value })}
                  >
                    {priorities.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-1 items-center gap-2 text-muted-foreground">
                  Labels
                  <Input
                    className="h-8 text-foreground"
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

              <label className="block space-y-2">
                <span className={H}>Description</span>
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

              {ticket.type === "epic" && (
                <EpicPanel
                  key={ticket.artifacts.find((a) => a.kind === "plan")?.id} // a revised plan resets the picks
                  ticket={ticket}
                  onAccept={(refs) =>
                    run(() => api(`/api/tickets/${ticket.id}/accept-proposals`, { body: { refs } }))
                  }
                />
              )}

              <section aria-labelledby="links-h" className="space-y-2">
                <h3 id="links-h" className={H}>
                  Links
                </h3>
                <ul className="space-y-1">
                  {ticket.links.map((l) => (
                    <li
                      key={l.id}
                      className={`flex items-center gap-2 text-sm ${l.confirmed ? "" : "opacity-70"}`}
                    >
                      <span className="w-20 shrink-0 text-muted-foreground">
                        {
                          { blocked_by: "blocked by", blocks: "blocks", relates: "relates to" }[
                            l.relation
                          ]
                        }
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {l.key} {l.title}
                      </span>
                      {!l.confirmed && (
                        <>
                          <span className="shrink-0 text-xs text-muted-foreground">proposed</span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              run(() =>
                                api(`/api/links/${l.id}`, {
                                  method: "PATCH",
                                  body: { confirmed: true },
                                }),
                              )
                            }
                          >
                            Confirm
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${l.confirmed ? "Remove" : "Dismiss"} link to ${l.key}`}
                        onClick={() => run(() => api(`/api/links/${l.id}`, { method: "DELETE" }))}
                      >
                        {l.confirmed ? "×" : "Dismiss"}
                      </Button>
                    </li>
                  ))}
                </ul>
                <form
                  action={(f) =>
                    run(() =>
                      api(`/api/tickets/${ticket.id}/links`, {
                        body: { toKey: f.get("toKey"), kind: "blocked_by" },
                      }),
                    )
                  }
                >
                  <Input
                    name="toKey"
                    required
                    aria-label="Blocked by"
                    placeholder="Blocked by… (e.g. KB-3)"
                  />
                </form>
              </section>

              <section aria-labelledby="ac-h" className="space-y-2">
                <h3 id="ac-h" className={H}>
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
                        onClick={() =>
                          run(() => api(`/api/criteria/${c.id}`, { method: "DELETE" }))
                        }
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
                  <ol className="space-y-2 border-l pl-4 text-sm">
                    {activity.map((a) => (
                      <li key={a.id} className="relative">
                        <span
                          aria-hidden
                          className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-border ring-4 ring-background"
                        />
                        <span className="text-xs text-muted-foreground">
                          {new Date(a.createdAt).toLocaleString()}
                        </span>{" "}
                        <span className="font-medium">{a.actor}</span> {describe(a)}
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
                    <p className="text-sm text-muted-foreground">
                      No agent has run on this ticket.
                    </p>
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
                  {ticket.artifacts.map((a, i) => {
                    // Each artifact says which agent's run made it, with that agent's color down its edge.
                    const edge = a.agentSlug
                      ? { borderLeftColor: agents[a.agentSlug]?.color ?? "var(--border)" }
                      : undefined;
                    const byline = (
                      <span className="flex flex-wrap items-center gap-x-1.5 text-xs font-normal text-muted-foreground">
                        {a.agentSlug ? <AgentTag slug={a.agentSlug} /> : <span>Kanbot</span>}
                        <span>· {new Date(a.createdAt).toLocaleString()}</span>
                      </span>
                    );
                    return i === ticket.artifacts.findIndex((b) => b.kind === a.kind) ? (
                      <article
                        key={a.id}
                        aria-label={`${a.title} v${a.version}`}
                        style={edge}
                        className="rounded-lg border border-l-4 bg-card p-4 shadow-xs"
                      >
                        <header className="mb-2 space-y-1">
                          <h3 className="text-sm font-semibold">
                            {a.title} <span className="text-muted-foreground">v{a.version}</span>
                          </h3>
                          {byline}
                        </header>
                        <Markdown>{a.contentMd}</Markdown>
                        <Screenshots
                          shots={ticket.screenshots.filter((x) => x.runId && x.runId === a.runId)}
                        />
                      </article>
                    ) : (
                      // Older versions are kept (UC-3); collapsed under the latest.
                      <details
                        key={a.id}
                        style={edge}
                        className="rounded-lg border border-l-4 bg-surface p-3 text-sm"
                      >
                        <summary className="cursor-pointer">
                          {a.title} v{a.version} {byline}
                        </summary>
                        <Markdown>{a.contentMd}</Markdown>
                        <Screenshots
                          shots={ticket.screenshots.filter((x) => x.runId && x.runId === a.runId)}
                        />
                      </details>
                    );
                  })}
                </TabsContent>

                <TabsContent value="diff">
                  <DiffView ticketId={ticket.id} refresh={change} />
                </TabsContent>

                <TabsContent value="comments" className="space-y-2">
                  <ul className="space-y-2">
                    {comments.map((c) => (
                      <li key={c.id} className="rounded-lg border bg-card p-3 text-sm">
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
        </DialogContent>
      </Dialog>
    </Agents.Provider>
  );
}

/** Blocked (§13, UC-7): Duckworth's questions, an answer box and Resume for the run that got stuck. */
type Proposal = {
  ref: string;
  title: string;
  descriptionMd: string;
  type: string;
  priority: string;
  acceptanceCriteria: string[];
  blockedBy: string[];
};

/** An epic (UC-11): Plan B's proposed tickets from its latest plan to accept, and the children so far. */
function EpicPanel({
  ticket,
  onAccept,
}: {
  ticket: TicketDetail;
  onAccept: (refs: string[]) => Promise<void>;
}) {
  // Artifacts are newest first, so the first plan is the latest.
  const plan = ticket.artifacts.find((a) => a.kind === "plan");
  const data = (plan?.data ?? {}) as {
    proposedTickets?: Proposal[];
    accepted?: Record<string, string>;
  };
  const proposals = data.proposedTickets ?? [];
  const accepted = data.accepted ?? {};
  const keyOf = (ref: string) => ticket.children.find((c) => c.id === accepted[ref])?.key;
  const open = proposals.filter((p) => !accepted[p.ref]);
  const [picked, setPicked] = useState<string[]>(() => open.map((p) => p.ref));
  const done = ticket.children.filter((c) => c.columnSlug === "done").length;

  return (
    <section aria-labelledby="epic-h" className="space-y-3 rounded-lg border bg-surface p-4">
      <h3 id="epic-h" className={H}>
        Epic{ticket.children.length > 0 && ` · ${done} of ${ticket.children.length} done`}
      </h3>
      {!plan && (
        <p className="text-sm text-muted-foreground">
          Move it to Planning: Plan B splits the description (or the file it names) into tickets.
        </p>
      )}
      {proposals.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm text-muted-foreground">Proposed tickets</h4>
          <ul className="space-y-2">
            {proposals.map((p) => {
              const key = keyOf(p.ref);
              return (
                <li key={p.ref} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Accept ${p.title}`}
                    disabled={!!accepted[p.ref]}
                    checked={!!accepted[p.ref] || picked.includes(p.ref)}
                    onChange={(e) =>
                      setPicked((s) =>
                        e.target.checked ? [...s, p.ref] : s.filter((r) => r !== p.ref),
                      )
                    }
                  />
                  <details className="min-w-0 flex-1">
                    <summary className="cursor-pointer">
                      <span className="text-muted-foreground">{p.ref}</span> {p.title}
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        · {p.type} · {p.priority}
                        {p.blockedBy.length > 0 && ` · after ${p.blockedBy.join(", ")}`}
                        {key && (
                          <>
                            {" "}
                            · created as <span className="whitespace-nowrap">{key}</span>
                          </>
                        )}
                      </span>
                    </summary>
                    {p.descriptionMd && <Markdown>{p.descriptionMd}</Markdown>}
                    {p.acceptanceCriteria.length > 0 && (
                      <ul className="list-disc pl-5 text-muted-foreground">
                        {p.acceptanceCriteria.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
          {open.length > 0 && (
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!picked.some((r) => !accepted[r])}
                onClick={() => onAccept(picked.filter((r) => !accepted[r]))}
              >
                Accept selected ({picked.filter((r) => !accepted[r]).length})
              </Button>
              <Button size="sm" variant="outline" onClick={() => onAccept(open.map((p) => p.ref))}>
                Accept all
              </Button>
            </div>
          )}
        </div>
      )}
      {ticket.children.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-sm text-muted-foreground">Children</h4>
          <ul className="space-y-1 text-sm">
            {ticket.children.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span className="shrink-0 whitespace-nowrap text-muted-foreground">{c.key}</span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.columnName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function BlockedPanel({
  ticket,
  onResume,
}: {
  ticket: TicketDetail;
  onResume: (runId: string, answer: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const stuck = ticket.runs.find((r) => r.columnSlug !== "blocked");
  const duck = ticket.runs[0]?.columnSlug === "blocked" ? ticket.runs[0] : undefined;
  // Only this visit's summary: one written before the stuck run started is about an earlier block.
  const blocker = ticket.artifacts.find(
    (a) => a.kind === "blocker" && stuck && new Date(a.createdAt) > new Date(stuck.createdAt),
  );
  return (
    <section
      aria-label="Blocker"
      className="space-y-2 rounded-lg border border-needs-fg/30 bg-needs/50 p-4"
    >
      {blocker ? (
        <Markdown>{blocker.contentMd}</Markdown>
      ) : (
        <p className="text-sm text-muted-foreground">
          {isActive(duck) ? "Rubber Duckworth is looking into it…" : "No blocker summary."}
        </p>
      )}
      {stuck && resumableRunStates.includes(stuck.state) && (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await onResume(stuck.id, answer);
            setBusy(false);
          }}
        >
          <Textarea
            aria-label="Your answer"
            placeholder={`Your answer for ${stuck.agentSlug}`}
            rows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy}>
            Resume {stuck.agentSlug}
          </Button>
        </form>
      )}
    </section>
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
  const agentName = useContext(Agents)[run.agentSlug]?.name ?? run.agentSlug;
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
    <section aria-label="Latest run" className="space-y-1 rounded-lg border bg-surface p-3 text-sm">
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny local SVG */}
        <img src={`/api/agents/${run.agentSlug}/avatar`} alt="" className="size-6 rounded-full" />
        {active && <Loader2 aria-hidden className="size-3.5 animate-spin text-running-fg" />}
        <span className="flex-1">
          <strong>{agentName}</strong> · {run.state.replace("_", " ")}
          {start && ` · ${Math.floor(secs / 60)}m ${secs % 60}s`}
          {/* shortcut: the SDK reports cost only when a run ends, so a running run shows none; a live figure needs a price table (M6). */}
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
      if (d.resumed)
        return `resumed ${String(d.agent)}${d.request ? ` with the answer "${String(d.request)}"` : ""}`;
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
      {c.agentSlug ? <AgentTag slug={c.agentSlug} /> : <span>owner</span>}
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
  /** File → the agents whose runs changed it, first first. */
  fileAgents: Record<string, string[]>;
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
  if (error) return <p className="text-sm text-destructive">{error}</p>;
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
      className="overflow-x-auto rounded-lg border bg-surface py-2 font-mono text-xs"
    >
      {diffRows(d.diff, d.comments).map((r, i) => (
        <div key={i}>
          {r.fileStart !== null && (
            // Each file opens with who changed it (from the runs' recorded files).
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-y bg-card px-3 py-1.5 font-sans first:mt-0">
              <span className="font-mono font-semibold text-foreground">{r.fileStart}</span>
              <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
                {d.fileAgents[r.fileStart]?.length ? (
                  <>
                    Changed by
                    {d.fileAgents[r.fileStart]!.map((s) => (
                      <AgentTag key={s} slug={s} />
                    ))}
                  </>
                ) : (
                  "No agent run recorded changing this file"
                )}
              </span>
            </div>
          )}
          <div className={`px-3 whitespace-pre ${r.cls}`}>{r.text || " "}</div>
          {r.notes.map((c) => (
            <div
              key={c.id}
              role="note"
              className="mx-3 my-1 rounded-md border bg-card p-2 font-sans whitespace-normal shadow-xs"
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
        ? "bg-ok text-ok-fg"
        : inHunk && text.startsWith("-")
          ? "bg-failed text-failed-fg"
          : !inHunk || hunk
            ? "text-muted-foreground"
            : "";
    const notes = at === null ? [] : comments.filter((c) => c.file === file && c.line === at);
    // "diff --git a/x b/x" starts a file; take b/'s path (it's also the old one for deletions).
    const fileStart = text.startsWith("diff --git ") ? (/ b\/(.+)$/.exec(text)?.[1] ?? null) : null;
    return { text, cls, notes, fileStart };
  });
}

/** QA's browser screenshots (§4) under the test report of the run that took them; each opens full size. */
function Screenshots({ shots }: { shots: TicketDetail["screenshots"] }) {
  if (!shots.length) return null;
  return (
    <ul aria-label="Screenshots" className="mt-3 flex flex-wrap gap-3">
      {shots.map((s) => (
        <li key={s.id} className="w-40">
          <a
            href={`/api/screenshots/${s.id}`}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md border bg-surface p-1 hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a session-guarded API image, not a static asset */}
            <img
              src={`/api/screenshots/${s.id}`}
              alt={s.name}
              loading="lazy"
              className="h-28 w-full rounded-sm object-cover object-top"
            />
            <span className="mt-1 block truncate text-xs text-muted-foreground" title={s.name}>
              {s.name}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
