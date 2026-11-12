"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RosterEntry } from "@/lib/agents";

type Card = RosterEntry;

const errorOf = async (r: Response) =>
  ((await r.json()) as { error: { message: string } }).error.message;

/** The Agents page (§13): the roster with this week's stats, and an editor for the agent file (FR-30, FR-31). */
export function AgentsPage({ initialSlug, version }: { initialSlug?: string; version?: string }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [slug, setSlug] = useState<string | undefined>(initialSlug);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null);
  // A past version (?v=) is read-only; picking another card leaves it.
  const [ver, setVer] = useState(version);

  const [reload, setReload] = useState(0); // bumped after a save, to refetch the roster
  useEffect(() => {
    fetch("/api/agents")
      .then(async (r) =>
        r.ok
          ? setCards((await r.json()) as Card[])
          : setMsg({ error: true, text: await errorOf(r) }),
      )
      .catch((e: Error) => setMsg({ error: true, text: e.message }));
  }, [reload]);

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/agents/${slug}${ver ? `?version=${ver}` : ""}`)
      .then(async (r) => {
        if (!r.ok) return setMsg({ error: true, text: await errorOf(r) });
        const d = (await r.json()) as { text: string; error?: string };
        setText(d.text);
        setSaved(d.text);
        setMsg(d.error ? { error: true, text: d.error } : null);
      })
      .catch((e: Error) => setMsg({ error: true, text: e.message }));
  }, [slug, ver]);

  async function save() {
    setMsg(null);
    const r = await fetch(`/api/agents/${slug}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return setMsg({ error: true, text: await errorOf(r) });
    setSaved(text);
    setMsg({ error: false, text: "Saved. The next run of this agent uses it." });
    setReload((n) => n + 1);
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 pb-16">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <ThemeToggle />
      </header>
      <div className="space-y-1">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Home
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
      </div>
      {!cards && !msg && <p className="text-muted-foreground">Loading…</p>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards?.map((c) => (
          <li key={c.slug}>
            <button
              type="button"
              onClick={() => {
                setVer(undefined);
                setSlug(c.slug);
              }}
              aria-pressed={slug === c.slug}
              className="w-full space-y-1 rounded-lg border bg-surface p-3 text-left text-sm aria-pressed:ring-2 aria-pressed:ring-ring"
              style={"name" in c ? { borderTopColor: c.color, borderTopWidth: 3 } : undefined}
            >
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- an SVG from our own route */}
                <img alt="" src={`/api/agents/${c.slug}/avatar`} className="size-8" />
                <strong>{"name" in c ? c.name : c.slug}</strong>
              </div>
              {"name" in c ? (
                <>
                  <p className="text-muted-foreground">{c.tagline}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.column} · {c.model}
                  </p>
                </>
              ) : (
                <p className="whitespace-pre-wrap text-destructive">{c.error}</p>
              )}
              <p className="text-xs">
                {c.week.runs} runs this week
                {c.week.successRate != null &&
                  ` · ${Math.round(c.week.successRate * 100)}% succeeded`}
                {c.week.runs > 0 && ` · avg $${c.week.avgCostUsd.toFixed(2)}`}
              </p>
            </button>
          </li>
        ))}
      </ul>
      {slug && (
        <section aria-label={`Edit ${slug}`} className="space-y-2">
          <h2 className="font-semibold">
            {slug}.md
            {ver && (
              <span className="font-normal text-muted-foreground">
                {" "}
                · version {ver.slice(0, 7)} (read-only)
              </span>
            )}
          </h2>
          <Textarea
            aria-label="Agent file"
            className="min-h-[28rem] font-mono text-xs"
            value={text}
            readOnly={!!ver}
            onChange={(e) => setText(e.target.value)}
          />
          {msg && (
            <p
              role={msg.error ? "alert" : "status"}
              className={`whitespace-pre-wrap text-sm ${msg.error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {msg.text}
            </p>
          )}
          {ver ? (
            <Button variant="outline" onClick={() => setVer(undefined)}>
              Back to the current file
            </Button>
          ) : (
            <Button onClick={() => void save()} disabled={text === saved}>
              Save
            </Button>
          )}
        </section>
      )}
    </main>
  );
}
