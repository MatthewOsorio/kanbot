"use client";

import { useContext } from "react";
import { Markdown } from "@/components/markdown";
import type { TicketDetail } from "@/lib/tickets";
import { Agents, AgentTag } from "./agent-tag";

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

/** Every artifact version, newest first: the latest of each kind open, older ones (UC-3) collapsed under it. */
export function ArtifactList({ ticket }: { ticket: TicketDetail }) {
  const agents = useContext(Agents);
  return ticket.artifacts.map((a, i) => {
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
    const content = (
      <>
        <Markdown>{a.contentMd}</Markdown>
        <Screenshots shots={ticket.screenshots.filter((x) => x.runId && x.runId === a.runId)} />
      </>
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
        {content}
      </article>
    ) : (
      <details
        key={a.id}
        style={edge}
        className="rounded-lg border border-l-4 bg-surface p-3 text-sm"
      >
        <summary className="cursor-pointer">
          {a.title} v{a.version} {byline}
        </summary>
        {content}
      </details>
    );
  });
}
