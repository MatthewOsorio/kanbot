"use client";

import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { StatusFlag } from "@kanbot/shared";
import {
  AlertTriangle,
  ArrowLeftRight,
  Bug,
  Clock,
  FlaskConical,
  Hand,
  Layers,
  Loader2,
  Sparkles,
  Wrench,
  GitPullRequest,
} from "lucide-react";
import type { Board as BoardData, Card } from "@/lib/projects";
import { PrStatus } from "./pr-status";
import { AgentAvatar } from "./agent-tag";

type ColumnData = BoardData["columns"][number];

type Agent = ColumnData["agent"];

export function Column(props: { column: ColumnData; count: number; children: React.ReactNode }) {
  const { column } = props;
  const { agent } = column;
  const { setNodeRef } = useDroppable({ id: column.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={column.name}
      className={`flex w-72 shrink-0 flex-col rounded-xl p-2 ${agent ? "bg-surface" : "border border-dashed bg-surface/50"}`}
      style={agent ? { boxShadow: `inset 0 3px 0 ${agent.color}` } : undefined}
    >
      <h2 className="mb-2 flex items-center gap-2.5 px-1.5 pt-1.5">
        {agent && (
          <AgentAvatar
            slug={agent.slug}
            alt={agent.name}
            title={`${agent.name}: ${agent.tagline}`}
            className="size-7 shrink-0 ring-2 ring-card"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{column.name}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {agent ? agent.name : "You decide"}
          </span>
        </span>
        <span
          className="rounded-full bg-background px-2 py-0.5 font-mono text-xs text-muted-foreground tabular-nums"
          aria-label={`${props.count} tickets`}
        >
          {props.count}
        </span>
      </h2>
      <div className="flex min-h-16 flex-1 flex-col gap-2">{props.children}</div>
    </section>
  );
}

export function SortableCard({
  card,
  cardKey,
  agent,
  onOpen,
}: {
  card: Card;
  cardKey: string;
  agent: Agent;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none ${isDragging ? "opacity-40" : ""}`}
      {...attributes}
      {...listeners}
      aria-label={`${cardKey}: ${card.title}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
        else listeners?.onKeyDown?.(e);
      }}
    >
      <CardBody card={card} cardKey={cardKey} agent={agent} />
    </div>
  );
}

const TYPE_ICON = {
  feature: Sparkles,
  bug: Bug,
  chore: Wrench,
  spike: FlaskConical,
  epic: Layers,
} as const;

const PRIORITY_CLS: Record<string, string> = {
  P0: "bg-failed text-failed-fg",
  P1: "bg-needs text-needs-fg",
};

export function CardBody({
  card,
  cardKey,
  agent,
  lifted,
}: {
  card: Card;
  cardKey: string;
  agent: Agent;
  lifted?: boolean;
}) {
  const TypeIcon = TYPE_ICON[card.type];
  return (
    <article
      className={`relative cursor-grab overflow-hidden rounded-lg border bg-card py-2.5 pr-2.5 pl-3.5 text-sm shadow-xs motion-safe:transition-[box-shadow,transform] group-hover:shadow-md motion-safe:group-hover:-translate-y-px ${lifted ? "rotate-1 shadow-lg" : ""}`}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: agent?.color ?? "var(--border)" }}
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <TypeIcon aria-hidden className="size-3.5" />
        <span className="font-mono">{cardKey}</span>
        <span className="sr-only">{card.type}</span>
        <span
          className={`ml-auto rounded px-1.5 font-mono text-[11px] leading-5 font-medium ${PRIORITY_CLS[card.priority] ?? "bg-muted"}`}
        >
          {card.priority}
        </span>
      </div>
      <p className="mt-1.5 leading-snug font-medium">{card.title}</p>
      {card.labels.length > 0 && (
        <ul aria-label="Labels" className="mt-2 flex flex-wrap gap-1">
          {card.labels.map((l) => (
            <li
              key={l}
              className="rounded-full border px-2 text-[11px] leading-5 text-muted-foreground"
            >
              {l}
            </li>
          ))}
        </ul>
      )}
      {card.epic && (
        <div
          className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
          title={`${card.epic.done} of ${card.epic.total} child tickets are Done`}
        >
          <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-ok-fg"
              style={{
                width: `${card.epic.total ? (card.epic.done / card.epic.total) * 100 : 0}%`,
              }}
            />
          </span>
          <span className="tabular-nums">
            {card.epic.done}/{card.epic.total} done
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 empty:hidden [&>*]:mt-2">
        <StatusPill flag={card.statusFlag} agent={agent} />
        {card.prNumber && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <GitPullRequest aria-hidden className="size-3" />
            PR #{card.prNumber}
          </span>
        )}
        {card.prNumber && <PrStatus ci={card.ciState} review={card.reviewState} />}
        {card.bounceCount > 0 && (
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            title={`Bounced back ${card.bounceCount} time${card.bounceCount > 1 ? "s" : ""}`}
          >
            ↩ {card.bounceCount}
          </span>
        )}
        {card.waitingOn.length > 0 && (
          <span className="text-xs text-needs-fg" title="Confirmed blockers that aren't Done">
            <Clock className="mr-1 inline size-3" aria-hidden />
            waiting on {card.waitingOn.join(", ")}
          </span>
        )}
        {card.overlaps.length > 0 && (
          <span
            className="text-xs text-muted-foreground"
            title="Touches the same files or hotspots"
          >
            <ArrowLeftRight className="mr-1 inline size-3" aria-hidden />
            overlaps {card.overlaps.join(", ")}
          </span>
        )}
      </div>
    </article>
  );
}

/** Card status pill (requirements §13): always an icon plus text, never color alone. */
function StatusPill({ flag, agent }: { flag: StatusFlag; agent: Agent }) {
  const pill = {
    running: {
      icon: <Loader2 className="size-3 animate-spin" />,
      text: "Working",
      cls: "bg-running text-running-fg",
    },
    plan_ready: {
      icon: <Hand className="size-3" />,
      text: "Plan ready · needs you",
      cls: "bg-needs text-needs-fg",
    },
    needs_input: {
      icon: <Hand className="size-3" />,
      text: "Needs you",
      cls: "bg-needs text-needs-fg",
    },
    awaiting_approval: {
      icon: <Hand className="size-3" />,
      text: "Approve · needs you",
      cls: "bg-needs text-needs-fg",
    },
    pr_open: {
      icon: <GitPullRequest className="size-3" />,
      text: "PR open · waiting on CI",
      cls: "bg-running text-running-fg",
    },
    failed: {
      icon: <AlertTriangle className="size-3" />,
      text: "Failed",
      cls: "bg-failed text-failed-fg",
    },
  }[flag as string];
  if (!pill) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {/* §13: a running card shows who's working. Decorative: the column header names the agent. */}
      {flag === "running" && agent && (
        <AgentAvatar slug={agent.slug} className="size-5 shrink-0 ring-2 ring-card" />
      )}
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${pill.cls}`}
      >
        {pill.icon}
        {pill.text}
      </span>
    </span>
  );
}
