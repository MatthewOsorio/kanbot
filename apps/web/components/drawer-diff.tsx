"use client";

import { useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { api } from "@/lib/client";
import { AgentTag, CommentByline, type Comment } from "./agent-tag";

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
export function DiffView({ ticketId, refresh }: { ticketId: string; refresh: unknown }) {
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
