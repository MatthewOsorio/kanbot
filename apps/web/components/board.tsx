"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardEvent, StatusFlag } from "@kanbot/shared";
import { AlertTriangle, ArrowLeftRight, Clock, Hand, Loader2 } from "lucide-react";
import { generateKeyBetween } from "fractional-indexing";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { TicketDrawer } from "@/components/ticket-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/client";
import type { Board as BoardData, Card } from "@/lib/projects";
import type { settingsView } from "@/lib/settings";

type Project = { id: string; name: string };
type ColumnData = BoardData["columns"][number];
type Health = Record<"database" | "worker" | "anthropic" | "github", string>;
type SettingsView = Awaited<ReturnType<typeof settingsView>>;

/** Flags that mean the owner has to act (the top bar's "Needs me" count). */
const NEEDS_ME: StatusFlag[] = ["needs_input", "plan_ready", "awaiting_approval", "failed"];

// Fractional keys compare by code unit (Postgres COLLATE "C"), so never use localeCompare here.
const byPosition = (a: Card, b: Card) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;

export function Board({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [board, setBoard] = useState<BoardData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<BoardEvent | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The start line stays up while that ticket's agent works and clears on its run.finished.
  const [notice, setNotice] = useState<{ ticketId: string; text: string } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const loadSeq = useRef(0);
  const closeDrawer = useCallback(() => setOpenId(null), []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      // Settings ride along: run.finished changes today's spend, settings.updated the rest.
      const [b, s] = await Promise.all([
        api<BoardData>(`/api/projects/${projectId}/board`),
        api<SettingsView>("/api/settings"),
      ]);
      if (seq !== loadSeq.current) return; // drop stale responses
      setBoard(b);
      setSettings(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    api<Project[]>("/api/projects").then(setProjects, () => {});
    // Every event and every (re)connect refetches the whole board: one path, always consistent.
    const es = new EventSource(`/api/events?projectId=${projectId}`);
    es.onopen = () => void load();
    es.onmessage = (m) => {
      const event = JSON.parse(m.data) as BoardEvent;
      setLastEvent(event);
      // FR-60: the in-app list is "Needs me"; the browser shows one too when allowed and we're not looking.
      if (
        event.type === "notification" &&
        document.hidden &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      )
        new Notification("Kanbot", { body: event.message });
      if (event.type === "run.finished")
        setNotice((n) => (n?.ticketId === event.ticketId ? null : n));
      if (event.type !== "run.event") void load(); // log lines don't change the board
    };
    return () => es.close();
  }, [projectId, load]);

  useEffect(() => {
    const check = () => api<Health>("/api/health").then(setHealth, () => setHealth(null));
    void check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] }, // Enter opens the card
    }),
  );

  if (!board) return <p className="p-8">{error || "Loading…"}</p>;

  const key = (c: Card) => `${board.project.keyPrefix}-${c.number}`;
  const cardsIn = (columnId: string) =>
    board.tickets.filter((t) => t.columnId === columnId).sort(byPosition);
  const dragging = board.tickets.find((t) => t.id === draggingId);

  // Screen-reader announcements by ticket key and column name (dnd-kit's defaults read out UUIDs).
  const cardName = (id: UniqueIdentifier) => {
    const t = board.tickets.find((x) => x.id === id);
    return t ? key(t) : "ticket";
  };
  const columnName = (id: UniqueIdentifier) => {
    const colId = board.tickets.find((x) => x.id === id)?.columnId ?? id;
    return board.columns.find((c) => c.id === colId)?.name ?? "no column";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${cardName(active.id)}.`,
    onDragOver: ({ active, over }) =>
      `${cardName(active.id)} is over ${over ? columnName(over.id) : "no column"}.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${cardName(active.id)} dropped in ${columnName(over.id)}.`
        : `${cardName(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${cardName(active.id)} was cancelled.`,
  };

  async function onDragEnd({ active, over }: DragEndEvent) {
    setDraggingId(null);
    if (!board || !over || active.id === over.id) return;
    const card = board.tickets.find((t) => t.id === active.id)!;
    const overCard = board.tickets.find((t) => t.id === over.id);
    const toColumnId = overCard ? overCard.columnId : String(over.id);
    const column = cardsIn(toColumnId);
    const dest = column.filter((t) => t.id !== card.id);
    let index = overCard ? dest.indexOf(overCard) : dest.length;
    // Dragging down within a column lands after the card you're over.
    if (overCard && card.columnId === toColumnId && column.indexOf(overCard) > column.indexOf(card))
      index += 1;
    const before = dest[index - 1]?.position ?? null;
    const after = dest[index]?.position ?? null;
    let position: string;
    try {
      position = generateKeyBetween(before, after);
    } catch {
      // shortcut: duplicate keys (two tabs racing) can't be split, so append to the column instead. Upgrade to server-side rebalancing if it shows up.
      position = generateKeyBetween(dest.at(-1)?.position ?? null, null);
    }

    const moved = { ...card, columnId: toColumnId, position };
    setBoard({ ...board, tickets: board.tickets.map((t) => (t.id === card.id ? moved : t)) });
    const target = board.columns.find((c) => c.id === toColumnId);
    type Flags = {
      confirmCancel?: boolean;
      startAnyway?: boolean;
      keepPlan?: boolean;
      requestMd?: string;
    };
    const move = (flags: Flags) =>
      api(`/api/tickets/${card.id}/move`, { body: { toColumnId, position, ...flags } });
    try {
      const flags: Flags = {};
      for (;;) {
        try {
          await move(flags);
          break;
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          // FR-24: moving a ticket whose agent is working cancels that run, so ask first.
          if (e.code === "run_active" && !flags.confirmCancel) {
            if (!confirm(`${e.message}. Cancel the run and move ${key(card)} to ${target?.name}?`))
              return void load();
            flags.confirmCancel = true;
          } else if (e.code === "overlap" && !flags.startAnyway) {
            // §9: overlap is advisory; the owner can start anyway.
            if (!confirm(`${key(card)} ${e.message.replace(/^O/, "o")}. Start anyway?`))
              return void load();
            flags.startAnyway = true;
          } else if (e.code === "has_plan" && !flags.keepPlan && !flags.requestMd) {
            // Back to Planning: ask before Plan B redoes the plan.
            if (confirm(`${key(card)} already has a plan. Have Plan B revise it?`)) {
              const request = prompt("What should Plan B change?")?.trim();
              if (!request) return void load();
              flags.requestMd = request;
            } else flags.keepPlan = true;
          } else throw e;
        }
      }
      if (target?.agent && card.columnId !== toColumnId && !flags.keepPlan)
        setNotice({ ticketId: card.id, text: target.agent.startLine });
    } catch (e) {
      setError((e as Error).message);
      void load(); // roll back the optimistic move
    }
  }

  async function quickAdd(form: FormData) {
    setError("");
    try {
      await api(`/api/projects/${projectId}/tickets`, { body: { title: form.get("title") } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
        <Link href="/" className="font-semibold">
          Kanbot
        </Link>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Project</span>
          <select
            className="rounded-md border bg-background px-2 py-1"
            value={projectId}
            onChange={(e) => router.push(`/p/${e.target.value}`)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <form action={quickAdd} className="flex-1">
          <Input
            name="title"
            required
            maxLength={200}
            aria-label="Quick add ticket"
            placeholder="Quick add: type an idea and press Enter"
            className="max-w-md"
          />
        </form>
        {/* aria-live without role="status": dnd-kit's live region is the page's one status role. */}
        <p aria-live="polite" aria-label="Agent notice" className="text-sm text-muted-foreground">
          {notice?.text}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <NeedsMe
          tickets={board.tickets.filter((t) => NEEDS_ME.includes(t.statusFlag))}
          cardKey={key}
          onOpen={setOpenId}
        />
        <Link
          href={`/p/${projectId}/settings`}
          className="text-sm underline-offset-4 hover:underline"
        >
          Settings
        </Link>
        {settings && <SpendControls settings={settings} onError={setError} />}
        <HealthDot health={health} />
      </header>
      {settings && <Banner settings={settings} health={health} />}

      <DndContext
        sensors={sensors}
        accessibility={{ announcements }}
        collisionDetection={rectIntersection} // closestCorners picks the dragged card's own slot over a tall column
        onDragStart={(e) => setDraggingId(String(e.active.id))}
        onDragCancel={() => setDraggingId(null)}
        onDragEnd={onDragEnd}
      >
        <main className="flex flex-1 gap-3 overflow-x-auto p-4">
          {board.columns.map((col) => {
            const cards = cardsIn(col.id);
            return (
              <Column key={col.id} column={col} count={cards.length}>
                <SortableContext
                  items={cards.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {cards.map((c) => (
                    <SortableCard
                      key={c.id}
                      card={c}
                      cardKey={key(c)}
                      onOpen={() => setOpenId(c.id)}
                    />
                  ))}
                </SortableContext>
              </Column>
            );
          })}
        </main>
        <DragOverlay>
          {dragging && <CardBody card={dragging} cardKey={key(dragging)} />}
        </DragOverlay>
      </DndContext>

      <TicketDrawer key={openId} ticketId={openId} lastEvent={lastEvent} onClose={closeDrawer} />
    </div>
  );
}

const FLAG_TEXT: Partial<Record<StatusFlag, string>> = {
  needs_input: "needs your answer",
  failed: "failed",
  plan_ready: "plan ready",
  awaiting_approval: "awaiting approval",
};

/** "Needs me" (§13, FR-60): the tickets waiting on the owner, and a switch for browser notifications. */
function NeedsMe(props: {
  tickets: Card[];
  cardKey: (c: Card) => string;
  onOpen: (id: string) => void;
}) {
  const { tickets, cardKey, onOpen } = props;
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );
  return (
    <div className="relative text-sm">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        Needs me: <strong>{tickets.length}</strong>
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 space-y-1 rounded-md border bg-background p-2 shadow-md">
          {tickets.length === 0 && <p className="text-muted-foreground">Nothing needs you.</p>}
          <ul aria-label="Tickets that need you">
            {tickets.map((t) => (
              <li key={t.id}>
                <button
                  className="w-full rounded px-1 py-0.5 text-left hover:bg-muted"
                  onClick={() => {
                    setOpen(false);
                    onOpen(t.id);
                  }}
                >
                  <span className="text-muted-foreground">{cardKey(t)}</span> {t.title}
                  <span className="block text-xs text-muted-foreground">
                    {FLAG_TEXT[t.statusFlag]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {permission === "default" && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => void Notification.requestPermission().then(setPermission)}
            >
              Turn on browser notifications
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Today's spend vs the daily cap (click to change the cap) and Pause all (§13, FR-63). */
function SpendControls(props: { settings: SettingsView; onError: (m: string) => void }) {
  const { settings: s, onError } = props;
  const [editing, setEditing] = useState(false);
  // No refetch here: the settings.updated event reloads the board and these settings.
  const patch = (body: object) =>
    api("/api/settings", { method: "PATCH", body }).catch((e: Error) => onError(e.message));
  return (
    <div className="flex items-center gap-2 text-sm">
      {editing ? (
        <form
          className="flex items-center gap-1"
          action={async (f) => {
            await patch({ dailyBudgetUsd: Number(f.get("cap")) });
            setEditing(false);
          }}
        >
          <label htmlFor="daily-cap">Daily cap $</label>
          <Input
            id="daily-cap"
            name="cap"
            type="number"
            min={0}
            step={0.5}
            defaultValue={s.dailyBudgetUsd}
            className="h-8 w-20"
            autoFocus
          />
          <Button size="sm" type="submit">
            Save
          </Button>
        </form>
      ) : (
        <button
          type="button"
          className="underline-offset-2 hover:underline"
          title="Change the daily cap"
          onClick={() => setEditing(true)}
        >
          Today {usd(s.spentTodayUsd)} / {usd(s.dailyBudgetUsd)}
        </button>
      )}
      <Button
        size="sm"
        variant={s.paused ? "default" : "outline"}
        aria-pressed={s.paused}
        onClick={() => void patch({ paused: !s.paused })}
      >
        {s.paused ? "Resume agents" : "Pause all"}
      </Button>
    </div>
  );
}

/** Why nothing is starting, when that's the case (§8 outage banner, §14 caps). */
function Banner({ settings: s, health }: { settings: SettingsView; health: Health | null }) {
  const lines = [
    s.paused &&
      `Agents are paused${s.pausedReason ? ` because of an ${s.pausedReason}` : ""}. Nothing new starts; stopped runs restart when you resume.`,
    s.spentTodayUsd >= s.dailyBudgetUsd &&
      `Daily budget reached (${usd(s.spentTodayUsd)} of ${usd(s.dailyBudgetUsd)}). Nothing new starts until midnight or until you raise the cap.`,
    health?.anthropic === "down" &&
      "Anthropic is unreachable. Interrupted runs restart on their own once it's back.",
  ].filter(Boolean);
  if (!lines.length) return null;
  return (
    <div role="alert" className="border-b bg-amber-100 px-4 py-2 text-sm text-amber-950">
      {lines.map((l) => (
        <p key={l as string}>{l}</p>
      ))}
    </div>
  );
}

function HealthDot({ health }: { health: Health | null }) {
  // Text, not just color (§15 accessibility): "All systems ok" or the parts that aren't.
  const bad = health
    ? Object.entries(health).filter(([k, v]) => v !== "ok" && !(k === "github" && v === "unknown"))
    : [["web", "unreachable"]];
  return (
    <span className="flex items-center gap-1 text-sm" title={health ? JSON.stringify(health) : ""}>
      <span
        aria-hidden
        className={`inline-block size-2 rounded-full ${bad.length ? "bg-amber-500" : "bg-green-600"}`}
      />
      {bad.length ? bad.map(([k, v]) => `${k} ${v}`).join(", ") : "All systems ok"}
    </span>
  );
}

function Column(props: { column: ColumnData; count: number; children: React.ReactNode }) {
  const { column } = props;
  const { setNodeRef } = useDroppable({ id: column.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={column.name}
      className="flex w-64 shrink-0 flex-col rounded-lg bg-muted/60 p-2"
    >
      <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-medium">
        {column.agent && (
          // eslint-disable-next-line @next/next/no-img-element -- tiny local SVG, no optimisation needed
          <img
            src={`/api/agents/${column.agent.slug}/avatar`}
            alt={column.agent.name}
            title={`${column.agent.name}: ${column.agent.tagline}`}
            className="size-5 rounded-full"
          />
        )}
        <span className="flex-1">{column.name}</span>
        <span className="text-muted-foreground" aria-label={`${props.count} tickets`}>
          {props.count}
        </span>
      </h2>
      <div className="flex min-h-16 flex-1 flex-col gap-2">{props.children}</div>
    </section>
  );
}

function SortableCard({
  card,
  cardKey,
  onOpen,
}: {
  card: Card;
  cardKey: string;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
      {...attributes}
      {...listeners}
      aria-label={`${cardKey}: ${card.title}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
        else listeners?.onKeyDown?.(e);
      }}
    >
      <CardBody card={card} cardKey={cardKey} />
    </div>
  );
}

function CardBody({ card, cardKey }: { card: Card; cardKey: string }) {
  return (
    <article className="cursor-grab rounded-md border bg-card p-2 text-sm shadow-sm">
      <div className="flex gap-2 text-xs text-muted-foreground">
        <span>{cardKey}</span>
        <span>{card.type}</span>
        <span>{card.priority}</span>
      </div>
      <p className="mt-1">{card.title}</p>
      {card.labels.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">{card.labels.join(", ")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill flag={card.statusFlag} />
        {card.epic && (
          <span
            className="mt-2 text-xs text-muted-foreground"
            title={`${card.epic.done} of ${card.epic.total} child tickets are Done`}
          >
            {card.epic.done}/{card.epic.total} done
          </span>
        )}
        {card.bounceCount > 0 && (
          <span
            className="mt-2 text-xs text-muted-foreground"
            title={`Bounced back ${card.bounceCount} time${card.bounceCount > 1 ? "s" : ""}`}
          >
            ↩ {card.bounceCount}
          </span>
        )}
        {card.waitingOn.length > 0 && (
          <span className="mt-2 text-xs text-amber-800" title="Confirmed blockers that aren't Done">
            <Clock className="mr-1 inline size-3" aria-hidden />
            waiting on {card.waitingOn.join(", ")}
          </span>
        )}
        {card.overlaps.length > 0 && (
          <span
            className="mt-2 text-xs text-muted-foreground"
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
function StatusPill({ flag }: { flag: StatusFlag }) {
  const pill = {
    running: {
      icon: <Loader2 className="size-3 animate-spin" />,
      text: "Working",
      cls: "bg-blue-100 text-blue-900",
    },
    plan_ready: {
      icon: <Hand className="size-3" />,
      text: "Plan ready · needs you",
      cls: "bg-amber-100 text-amber-900",
    },
    needs_input: {
      icon: <Hand className="size-3" />,
      text: "Needs you",
      cls: "bg-amber-100 text-amber-900",
    },
    awaiting_approval: {
      icon: <Hand className="size-3" />,
      text: "Approve · needs you",
      cls: "bg-amber-100 text-amber-900",
    },
    failed: {
      icon: <AlertTriangle className="size-3" />,
      text: "Failed",
      cls: "bg-red-100 text-red-900",
    },
  }[flag as string];
  if (!pill) return null;
  return (
    <span
      className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${pill.cls}`}
    >
      {pill.icon}
      {pill.text}
    </span>
  );
}
