"use client";

import { type BoardEvent, priorities, QA_SETUP_MESSAGE, ticketTypes } from "@kanbot/shared";
import { GitBranch, GitPullRequest, Layers } from "lucide-react";
import { useEffect, useState } from "react";
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
import { PrStatus } from "./pr-status";
import { Agents, CommentByline, type AgentInfo, type Comment } from "./agent-tag";
import { describe, LiveLog, type Activity } from "./drawer-activity";
import { ArtifactList } from "./drawer-artifacts";
import { DiffView } from "./drawer-diff";
import { BlockedPanel, EpicPanel, H, isActive, RunBar } from "./drawer-panels";

/** Header chip style. */
const CHIP = "inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-0.5";

const statusMark = { open: "○ open", pass: "✓ pass", fail: "✗ fail" } as const;

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
                  {ticket.prNumber && <PrStatus ci={ticket.ciState} review={ticket.reviewState} />}
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
                  <ArtifactList ticket={ticket} />
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
