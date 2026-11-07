"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** One env var as the browser knows it (§10): its name, whether a value is stored, and a new value if typed. */
export type EnvRow = { name: string; set: boolean; value?: string; isNew?: boolean };

/** The API's `env` body: the whole set, null where the stored value stays. */
export const envBody = (rows: EnvRow[]) =>
  Object.fromEntries(
    rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value ?? null]),
  );

/**
 * The project's env vars (API keys, connection strings) for its commands. Values are write-only: the
 * server never sends them back, so a stored one shows as "set" and typing replaces it.
 */
export function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (r: EnvRow[]) => void }) {
  const update = (i: number, r: Partial<EnvRow>) =>
    onChange(rows.map((x, j) => (j === i ? { ...x, ...r } : x)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          {r.isNew ? (
            <Input
              className="w-2/5 font-mono"
              placeholder="NAME"
              aria-label="Variable name"
              value={r.name}
              onChange={(e) => update(i, { name: e.target.value })}
            />
          ) : (
            <code className="w-2/5 truncate" title={r.name}>
              {r.name}
            </code>
          )}
          <Input
            type="password"
            autoComplete="off"
            className="flex-1 font-mono"
            aria-label={`Value of ${r.name || "the new variable"}`}
            placeholder={r.set ? "Set (type to replace)" : "Not set"}
            value={r.value ?? ""}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${r.name || "the new variable"}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { name: "", set: false, isNew: true }])}
      >
        <Plus aria-hidden className="size-4" /> Add variable
      </Button>
    </div>
  );
}
