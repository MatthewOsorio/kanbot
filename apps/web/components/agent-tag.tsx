"use client";

import { createContext, useContext } from "react";
import { api } from "@/lib/client";

export type Comment = {
  id: string;
  bodyMd: string;
  createdAt: string;
  authorKind: "user" | "agent";
  agentSlug: string | null;
  file: string | null;
  line: number | null;
  resolved: boolean;
};

/** The board's agents by slug (name, color), so everything an agent made says who made it. */
export type AgentInfo = { name: string; color: string };
export const Agents = createContext<Record<string, AgentInfo>>({});

/** An agent's avatar and name; the slug when its file is gone. */
export function AgentTag({ slug, className = "" }: { slug: string; className?: string }) {
  const a = useContext(Agents)[slug];
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${className}`}>
      <AgentAvatar slug={slug} className="size-4" />
      <span className="text-foreground">{a?.name ?? slug}</span>
    </span>
  );
}

/** Who wrote a comment: the agent (avatar + name) or the owner, plus file:line for review comments. */
export function CommentByline({ c }: { c: Comment }) {
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

/** An agent's round avatar; decorative unless given `alt`. */
export function AgentAvatar(props: {
  slug: string;
  alt?: string;
  title?: string;
  className: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny local SVG, no optimisation needed
    <img
      src={`/api/agents/${props.slug}/avatar`}
      alt={props.alt ?? ""}
      title={props.title}
      className={`rounded-full ${props.className}`}
    />
  );
}
