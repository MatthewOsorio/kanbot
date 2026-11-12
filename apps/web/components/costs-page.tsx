"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/brand";
import { SpendControls, type SettingsView } from "@/components/board-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Row = {
  label: string;
  title: string | null;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};
type Report = { rows: Row[]; totals: Omit<Row, "label" | "title"> };
const GROUPS = ["day", "agent", "ticket"] as const;
type Group = (typeof GROUPS)[number];

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** The Costs page (§13): spend by day, agent or ticket with token counts, and the daily cap. */
export function CostsPage() {
  const [groupBy, setGroupBy] = useState<Group>("day");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ groupBy, ...(from && { from }), ...(to && { to }) });
    fetch(`/api/costs?${q}`)
      .then(async (r) => {
        const d = (await r.json()) as Report & { error?: { message: string } };
        if (!r.ok) return setError(d.error?.message ?? "Could not load costs");
        setError(null);
        setReport(d);
      })
      .catch((e: Error) => setError(e.message));
  }, [groupBy, from, to]);

  // SpendControls has no refetch of its own (the board gets a settings.updated event), so poll.
  useEffect(() => {
    const load = () =>
      fetch("/api/settings")
        .then(async (r) => r.ok && setSettings((await r.json()) as SettingsView))
        .catch(() => {});
    void load();
    const t = setInterval(() => void load(), 3_000);
    return () => clearInterval(t);
  }, []);

  const max = Math.max(0, ...(report?.rows.map((r) => r.costUsd) ?? []));
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 pb-16">
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
        <h1 className="text-2xl font-semibold tracking-tight">Costs</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {settings && <SpendControls settings={settings} onError={setError} />}
        <span className="text-sm text-muted-foreground">
          The per-ticket budget is set in each project&apos;s Settings.
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Group by" className="flex gap-1">
          {GROUPS.map((g) => (
            <Button
              key={g}
              size="sm"
              variant={g === groupBy ? "default" : "outline"}
              onClick={() => setGroupBy(g)}
            >
              By {g}
            </Button>
          ))}
        </div>
        <label className="text-sm">
          From{" "}
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </label>
        <label className="text-sm">
          To{" "}
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {report && (
        <>
          <p className="text-sm">
            <strong>${report.totals.costUsd.toFixed(2)}</strong> over {report.totals.runs} runs ·{" "}
            {tokens(report.totals.inputTokens)} in / {tokens(report.totals.outputTokens)} out
            {groupBy === "ticket" && " (top 50 tickets by cost)"}
          </p>
          {report.rows.length === 0 && (
            <p className="text-muted-foreground">No runs in this range.</p>
          )}
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">{groupBy}</th>
                <th className="font-medium">Cost</th>
                <th className="text-right font-medium">Runs</th>
                <th className="text-right font-medium">Tokens in / out</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.label} className="border-t">
                  <td className="py-1.5 pr-3">
                    {r.label}
                    {r.title && <span className="text-muted-foreground"> {r.title}</span>}
                  </td>
                  <td className="w-1/3 pr-3">
                    {/* CSS bars, no chart library (M6 phase 3 deviation). */}
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2 rounded bg-primary"
                        style={{ width: `${max ? (r.costUsd / max) * 100 : 0}%`, minWidth: 2 }}
                      />
                      <span>${r.costUsd.toFixed(2)}</span>
                    </div>
                  </td>
                  <td className="text-right">{r.runs}</td>
                  <td className="text-right">
                    {tokens(r.inputTokens)} / {tokens(r.outputTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
