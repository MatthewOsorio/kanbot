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
import type { BoardEvent } from "@kanbot/shared";
import { generateKeyBetween } from "fractional-indexing";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { TicketDrawer } from "@/components/ticket-drawer";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";
import type { Board as BoardData, Card } from "@/lib/projects";

type Project = { id: string; name: string };

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
  const loadSeq = useRef(0);
  const closeDrawer = useCallback(() => setOpenId(null), []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const b = await api<BoardData>(`/api/projects/${projectId}/board`);
      if (seq === loadSeq.current) setBoard(b); // drop stale responses
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
      setLastEvent(JSON.parse(m.data) as BoardEvent);
      void load();
    };
    return () => es.close();
  }, [projectId, load]);

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
    try {
      await api(`/api/tickets/${card.id}/move`, { body: { toColumnId, position } });
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
      <header className="flex items-center gap-4 border-b px-4 py-2">
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
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </header>

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
              <Column key={col.id} id={col.id} name={col.name} count={cards.length}>
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

function Column(props: { id: string; name: string; count: number; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: props.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={props.name}
      className="flex w-64 shrink-0 flex-col rounded-lg bg-muted/60 p-2"
    >
      <h2 className="mb-2 flex justify-between px-1 text-sm font-medium">
        {props.name}
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
    </article>
  );
}
