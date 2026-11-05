"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Settings = {
  name: string;
  keyPrefix: string;
  commands: { install?: string; build?: string; test?: string; lint?: string };
  testGlobs: string[];
  hotspots: { name: string; paths: string[] }[];
  bounceLimit: number;
  concurrency: number;
};

const COMMANDS = ["install", "build", "test", "lint"] as const;

// shortcut: a glob can't contain a comma here (the hotspot line splits on commas); use a row editor if one needs {a,b}.
const hotspotLines = (h: Settings["hotspots"]) =>
  h.map((g) => `${g.name}: ${g.paths.join(", ")}`).join("\n");
const parseHotspots = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      return {
        name: i < 0 ? l : l.slice(0, i).trim(),
        paths:
          i < 0
            ? []
            : l
                .slice(i + 1)
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean),
      };
    });

/** Project Settings (§13): commands, test globs, hotspots, bounce limit, concurrency. */
export function SettingsForm({ projectId }: { projectId: string }) {
  const [s, setS] = useState<Settings | null>(null);
  const [globs, setGlobs] = useState("");
  const [hotspots, setHotspots] = useState("");
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null);

  const load = (d: Settings) => {
    setS(d);
    setGlobs(d.testGlobs.join("\n"));
    setHotspots(hotspotLines(d.hotspots));
  };
  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then(async (r) =>
        r.ok ? load(await r.json()) : setMsg({ error: true, text: (await r.json()).error.message }),
      )
      .catch((e: Error) => setMsg({ error: true, text: e.message }));
  }, [projectId]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!s) return;
    setMsg(null);
    const body = {
      // An empty command clears it (the API treats "" as none).
      commands: Object.fromEntries(COMMANDS.map((c) => [c, s.commands[c] ?? ""])),
      testGlobs: globs
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      hotspots: parseHotspots(hotspots),
      bounceLimit: s.bounceLimit,
      concurrency: s.concurrency,
    };
    const r = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) return setMsg({ error: true, text: d.error.message });
    load(d);
    setMsg({ error: false, text: "Saved" });
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <Link href={`/p/${projectId}`} className="text-sm underline-offset-4 hover:underline">
        ← Back to board
      </Link>
      <h1 className="text-xl font-semibold">{s ? `${s.name} settings` : "Settings"}</h1>
      {!s && !msg && <p className="text-muted-foreground">Loading…</p>}
      {s && (
        <form onSubmit={save} className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="font-medium">Commands</legend>
            <p className="text-sm text-muted-foreground">
              One plain command each: no pipes, chaining or redirects. Agents run them through the
              permission fence.
            </p>
            {COMMANDS.map((c) => (
              <label key={c} className="block space-y-1 text-sm">
                <span className="capitalize">{c}</span>
                <Input
                  value={s.commands[c] ?? ""}
                  onChange={(e) => setS({ ...s, commands: { ...s.commands, [c]: e.target.value } })}
                />
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Test globs</span>
            <span className="block text-muted-foreground">
              One per line. Testy McTestface may only edit files that match.
            </span>
            <Textarea value={globs} onChange={(e) => setGlobs(e.target.value)} rows={3} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Hotspots</span>
            <span className="block text-muted-foreground">
              One group per line: <code>name: glob, glob</code>. Tickets touching the same group
              overlap.
            </span>
            <Textarea value={hotspots} onChange={(e) => setHotspots(e.target.value)} rows={3} />
          </label>
          <div className="flex gap-6">
            <label className="space-y-1 text-sm">
              <span className="block">Bounce limit (1–10)</span>
              <Input
                type="number"
                min={1}
                max={10}
                value={s.bounceLimit}
                onChange={(e) => setS({ ...s, bounceLimit: Number(e.target.value) })}
                className="w-28"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block">Concurrent runs (1–4)</span>
              <Input
                type="number"
                min={1}
                max={4}
                value={s.concurrency}
                onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) })}
                className="w-28"
              />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit">Save</Button>
            {msg && (
              <p
                role={msg.error ? "alert" : "status"}
                className={msg.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
              >
                {msg.text}
              </p>
            )}
          </div>
        </form>
      )}
      {!s && msg && (
        <p role="alert" className="text-destructive">
          {msg.text}
        </p>
      )}
    </main>
  );
}
