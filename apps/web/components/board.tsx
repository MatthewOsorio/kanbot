"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { BoardEvent, StatusFlag } from "@kanbot/shared";
import { AlertTriangle, Plus, Settings } from "lucide-react";
import { generateKeyBetween } from "fractional-indexing";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SELECT, Wordmark } from "@/components/brand";
import { SignOut, ThemeToggle } from "@/components/theme-toggle";
import { TicketDrawer } from "@/components/ticket-drawer";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/client";
import type { Board as BoardData, Card } from "@/lib/projects";
import { CardBody, Column, SortableCard } from "./board-card";
import {
  Banner,
  HealthDot,
  NeedsMe,
  SpendControls,
  type Health,
  type SettingsView,
} from "./board-header";

type Project = { id: string; name: string };

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
      const event = JSON.parse(m.data as string) as BoardEvent;
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
    const t = setInterval(() => void check(), 30_000);
    return () => clearInterval(t);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] }, // Enter opens the card
    }),
  );

  if (!board) return <p className="p-8 text-muted-foreground">{error || "Loading…"}</p>;

  const key = (c: Card) => `${board.project.keyPrefix}-${c.number}`;
  const prReviewId = board.columns.find((c) => c.slug === "pr_review")?.id;
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
      confirmSkip?: boolean;
      confirmClose?: boolean;
    };
    // Each of these 409s asks once; yes sets its flag and the move is tried again.
    const asks: Record<string, [Exclude<keyof Flags, "requestMd">, (m: string) => string]> = {
      // FR-24: moving a ticket whose agent is working cancels that run.
      run_active: [
        "confirmCancel",
        (m) => `${m}. Cancel the run and move ${key(card)} to ${target?.name}?`,
      ],
      // §9: overlap is advisory; the owner can start anyway.
      overlap: ["startAnyway", (m) => `${key(card)} ${m.replace(/^O/, "o")}. Start anyway?`],
      // §3: Ship before review or QA passed.
      skip_gates: ["confirmSkip", (m) => `${key(card)}: ${m}. Ship it anyway?`],
      // §3: Done without a merge closes the PR on GitHub (the branch stays).
      pr_open: ["confirmClose", (m) => `${key(card)}: ${m}. Close the PR without merging?`],
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
          const ask = e.code ? asks[e.code] : undefined;
          if (ask && !flags[ask[0]]) {
            if (!confirm(ask[1](e.message))) return void load();
            flags[ask[0]] = true;
          } else if (e.code === "has_plan" && !flags.keepPlan && !flags.requestMd) {
            // Back to Planning: ask before Plan B redoes the plan.
            if (confirm(`${key(card)} already has a plan. Have Plan B revise it?`)) {
              const request = prompt("What should Plan B change?")?.trim();
              if (!request) return void load();
              flags.requestMd = request;
            } else flags.keepPlan = true;
          } else if (e.code === "no_pr") {
            // §3: PR Review needs a PR; offer to run Ship first.
            if (!confirm(`${key(card)} has no pull request yet. Move it to Ship to open one?`))
              return void load();
            const ship = board.columns.find((c) => c.slug === "ship");
            if (!ship) return void load();
            await api(`/api/tickets/${card.id}/move`, {
              body: {
                toColumnId: ship.id,
                position: generateKeyBetween(
                  board.tickets.filter((t) => t.columnId === ship.id).at(-1)?.position ?? null,
                  null,
                ),
                ...flags,
                confirmSkip: true,
              },
            });
            break;
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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-card px-4 py-2.5">
        <Wordmark />
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Project</span>
          <select
            className={SELECT}
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
        <form action={quickAdd} className="relative min-w-48 flex-1">
          <Plus
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            name="title"
            required
            maxLength={200}
            aria-label="Quick add ticket"
            placeholder="Quick add: type an idea and press Enter"
            className="max-w-md bg-background pl-8"
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
        <div className="flex flex-wrap items-center gap-2">
          <NeedsMe
            reviewColumnId={prReviewId}
            tickets={board.tickets.filter(
              (t) => NEEDS_ME.includes(t.statusFlag) || t.columnId === prReviewId,
            )}
            cardKey={key}
            onOpen={setOpenId}
          />
          {settings && <SpendControls settings={settings} onError={setError} />}
          <HealthDot health={health} />
          <Link
            href={`/p/${projectId}/settings`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <Settings aria-hidden />
            Settings
          </Link>
          <ThemeToggle />
          <SignOut />
        </div>
      </header>
      {settings && <Banner settings={settings} health={health} />}
      {board.project.onboarding && board.project.onboarding.step !== "ready" && (
        <div role="alert" className="flex gap-2 border-b bg-needs px-4 py-2 text-sm text-needs-fg">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            Setup isn&apos;t finished, so agents don&apos;t start yet.{" "}
            <Link
              href={`/p/${projectId}/setup`}
              className="font-medium underline underline-offset-4"
            >
              Finish setup
            </Link>
          </p>
        </div>
      )}

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
                      agent={col.agent}
                      onOpen={() => setOpenId(c.id)}
                    />
                  ))}
                </SortableContext>
              </Column>
            );
          })}
        </main>
        <DragOverlay>
          {dragging && (
            <CardBody
              card={dragging}
              cardKey={key(dragging)}
              agent={board.columns.find((c) => c.id === dragging.columnId)?.agent ?? null}
              lifted
            />
          )}
        </DragOverlay>
      </DndContext>

      <TicketDrawer
        key={openId}
        ticketId={openId}
        lastEvent={lastEvent}
        onClose={closeDrawer}
        agents={Object.fromEntries(
          board.columns.flatMap((c) => (c.agent ? [[c.agent.slug, c.agent]] : [])),
        )}
      />
    </div>
  );
}
