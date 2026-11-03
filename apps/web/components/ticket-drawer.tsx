"use client";

import { priorities, ticketTypes, type BoardEvent } from "@kanbot/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import type { TicketDetail } from "@/lib/tickets";

type Comment = { id: string; bodyMd: string; createdAt: string };
type Activity = {
  id: string;
  actor: string;
  action: string;
  data: Record<string, unknown>;
  createdAt: string;
};

const statusMark = { open: "○ open", pass: "✓ pass", fail: "✗ fail" } as const;

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
  const change = lastEvent?.ticketId === ticketId ? lastEvent : null;

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
              <SheetDescription>
                {ticket.key} · {ticket.columnName}
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

            {/* Tabs (Activity, Live, Artifacts, Diff, Comments) arrive with M2; M1 stacks the two it has. */}
            <section aria-labelledby="comments-h" className="space-y-2">
              <h3 id="comments-h" className="text-sm font-medium">
                Comments
              </h3>
              <ul className="space-y-2">
                {comments.map((c) => (
                  <li key={c.id} className="rounded-md border p-2 text-sm">
                    <p className="whitespace-pre-wrap">{c.bodyMd}</p>
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
            </section>

            <section aria-labelledby="activity-h" className="space-y-2">
              <h3 id="activity-h" className="text-sm font-medium">
                Activity
              </h3>
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
            </section>

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
      return d.change
        ? `${String(d.change)} criterion "${String(d.text)}"`
        : `edited ${(d.fields as string[]).join(", ")}`;
    default:
      return a.action;
  }
}
