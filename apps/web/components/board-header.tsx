"use client";

import type { StatusFlag } from "@kanbot/shared";
import { AlertTriangle, Hand, Pause, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";
import type { Card } from "@/lib/projects";
import type { settingsView } from "@/lib/settings";

export type Health = Record<"database" | "worker" | "anthropic" | "github", string>;

export type SettingsView = Awaited<ReturnType<typeof settingsView>>;

const FLAG_TEXT: Partial<Record<StatusFlag, string>> = {
  needs_input: "needs your answer",
  failed: "failed",
  plan_ready: "plan ready",
  awaiting_approval: "awaiting approval",
};

/** "Needs me" (§13, FR-60): the tickets waiting on the owner, and a switch for browser notifications. */
export function NeedsMe(props: {
  tickets: Card[];
  cardKey: (c: Card) => string;
  onOpen: (id: string) => void;
  /** PR Review: its tickets wait for the owner's review on GitHub (FR-60). */
  reviewColumnId?: string;
}) {
  const { tickets, cardKey, onOpen, reviewColumnId } = props;
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );
  return (
    <div className="relative text-sm">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Hand aria-hidden />
        Needs me
        <strong
          className={`min-w-5 rounded-full px-1.5 text-center text-xs leading-5 ${tickets.length ? "bg-needs text-needs-fg" : "bg-muted text-muted-foreground"}`}
        >
          {tickets.length}
        </strong>
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 space-y-1 rounded-lg border bg-popover p-1.5 shadow-lg">
          {tickets.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">Nothing needs you.</p>
          )}
          <ul aria-label="Tickets that need you">
            {tickets.map((t) => (
              <li key={t.id}>
                <button
                  className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => {
                    setOpen(false);
                    onOpen(t.id);
                  }}
                >
                  <span className="font-mono text-xs text-muted-foreground">{cardKey(t)}</span>{" "}
                  {t.title}
                  <span
                    className={`block text-xs ${t.statusFlag === "failed" ? "text-failed-fg" : "text-muted-foreground"}`}
                  >
                    {FLAG_TEXT[t.statusFlag] ??
                      (t.columnId === reviewColumnId ? "PR ready for your review" : null)}
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
export function SpendControls(props: { settings: SettingsView; onError: (m: string) => void }) {
  const { settings: s, onError } = props;
  const [editing, setEditing] = useState(false);
  // No refetch here: the settings.updated event reloads the board and these settings.
  const patch = (body: object) =>
    api("/api/settings", { method: "PATCH", body }).catch((e: Error) => onError(e.message));
  const used = s.dailyBudgetUsd > 0 ? Math.min(1, s.spentTodayUsd / s.dailyBudgetUsd) : 1;
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
          className="flex flex-col gap-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          title="Change the daily cap"
          onClick={() => setEditing(true)}
        >
          <span className="font-mono text-xs tabular-nums">
            Today {usd(s.spentTodayUsd)} / {usd(s.dailyBudgetUsd)}
          </span>
          <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <span
              className={`block h-full rounded-full ${used >= 1 ? "bg-destructive" : used >= 0.8 ? "bg-amber-500" : "bg-primary"}`}
              style={{ width: `${used * 100}%` }}
            />
          </span>
        </button>
      )}
      <Button
        size="sm"
        variant={s.paused ? "default" : "outline"}
        aria-pressed={s.paused}
        onClick={() => void patch({ paused: !s.paused })}
      >
        {s.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
        {s.paused ? "Resume agents" : "Pause all"}
      </Button>
    </div>
  );
}

/** Why nothing is starting, when that's the case (§8 outage banner, §14 caps). */
export function Banner({ settings: s, health }: { settings: SettingsView; health: Health | null }) {
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
    <div role="alert" className="flex gap-2 border-b bg-needs px-4 py-2 text-sm text-needs-fg">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>
        {lines.map((l) => (
          <p key={l as string}>{l}</p>
        ))}
      </div>
    </div>
  );
}

export function HealthDot({ health }: { health: Health | null }) {
  // Text, not just color (§15 accessibility): "All systems ok" or the parts that aren't.
  const bad = health
    ? Object.entries(health).filter(([k, v]) => v !== "ok" && !(k === "github" && v === "unknown"))
    : [["web", "unreachable"]];
  return (
    <span
      className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
      title={health ? JSON.stringify(health) : ""}
    >
      <span
        aria-hidden
        className={`inline-block size-2 rounded-full ring-2 ${bad.length ? "bg-amber-500 ring-amber-500/25" : "bg-emerald-500 ring-emerald-500/25"}`}
      />
      {bad.length ? bad.map(([k, v]) => `${k} ${v}`).join(", ") : "All systems ok"}
    </span>
  );
}
