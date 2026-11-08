"use client";

import { activeRunStates, resumableRunStates } from "@kanbot/shared";
import { Loader2 } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TicketDetail } from "@/lib/tickets";
import { AgentAvatar, Agents } from "./agent-tag";

/** Section heading style. */
export const H = "block text-xs font-semibold tracking-wide text-muted-foreground uppercase";

type Run = TicketDetail["runs"][number];

export const isActive = (r: Run | undefined) =>
  !!r && (activeRunStates as readonly string[]).includes(r.state);

const RETRYABLE = ["failed", "interrupted", "timed_out", "budget_exceeded", "cancelled"];

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
export function EpicPanel({
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

/** Blocked (§13, UC-7): Duckworth's questions, an answer box and Resume for the run that got stuck. */
export function BlockedPanel({
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
export function RunBar({
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
        <AgentAvatar slug={run.agentSlug} className="size-6" />
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
