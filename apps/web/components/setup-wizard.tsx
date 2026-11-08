"use client";

import type { Baseline, Onboarding, OnboardingStep } from "@kanbot/shared/onboarding";
import { ArrowRight, Check, CircleAlert, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Wordmark } from "@/components/brand";
import { EnvEditor, envBody, type EnvRow } from "@/components/env-editor";
import { SignOut, ThemeToggle } from "@/components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

type Commands = { install?: string; build?: string; test?: string; lint?: string; start?: string };
type Setup = {
  id: string;
  name: string;
  repo: string;
  defaultBranch: string;
  onboarding: Onboarding;
  commands: Commands | null;
  image: string;
  dockerfile: string | null;
  testGlobs: string[];
  env: { name: string; set: boolean }[];
  baseline: Baseline | null;
  workflows: string[] | null;
  protection: { missing: string[] } | { error: string } | null;
};

const STEPS: { step: OnboardingStep; title: string }[] = [
  { step: "clone", title: "Clone" },
  { step: "commands", title: "Commands" },
  { step: "baseline", title: "Baseline" },
  { step: "ci", title: "CI" },
  { step: "protection", title: "Branch protection" },
  { step: "ready", title: "Ready" },
];
const COMMANDS = ["install", "build", "test", "lint", "start"] as const;

/** Onboarding a GitHub repo (§10), one step at a time; every event for the project refetches it. */
export function SetupWizard({ projectId }: { projectId: string }) {
  const [s, setS] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<Setup>(`/api/projects/${projectId}/onboarding`).then(
        (d) => (setS(d), setError("")),
        (e: Error) => setError(e.message),
      ),
    [projectId],
  );
  useEffect(() => {
    const es = new EventSource(`/api/events?projectId=${projectId}`);
    es.onopen = () => void load();
    es.onmessage = (m) => {
      if ((JSON.parse(m.data) as { type: string }).type === "project.onboarding") void load();
    };
    return () => es.close();
  }, [projectId, load]);

  async function act(body: object) {
    setBusy(true);
    setError("");
    try {
      setS(await api<Setup>(`/api/projects/${projectId}/onboarding`, { body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = s ? STEPS.findIndex((x) => x.step === s.onboarding.step) : -1;
  return (
    <div className="mx-auto max-w-3xl px-6 pb-16">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <SignOut />
        </div>
      </header>
      <main className="space-y-6 pt-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Set up {s?.name ?? "project"}</h1>
          {s && (
            <p className="font-mono text-sm text-muted-foreground">
              {s.repo} · {s.defaultBranch}
            </p>
          )}
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {!s && !error && <p className="text-muted-foreground">Loading…</p>}
        {s && (
          <ol className="space-y-3">
            {STEPS.map((x, i) => {
              const done = i < current || (x.step === "ready" && i === current);
              const here = i === current && x.step !== "ready";
              return (
                <li
                  key={x.step}
                  aria-current={here ? "step" : undefined}
                  className={cn(
                    "rounded-xl border bg-card p-4 shadow-xs",
                    here ? "border-primary/50" : "opacity-80",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "grid size-7 place-items-center rounded-full text-xs font-semibold",
                        done
                          ? "bg-ok text-ok-fg"
                          : here
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {done ? <Check aria-label="done" className="size-4" /> : i + 1}
                    </span>
                    <h2 className={cn("font-semibold", !done && !here && "text-muted-foreground")}>
                      {x.title}
                    </h2>
                  </div>
                  {(here || (x.step === "ready" && i === current)) && (
                    <div className="mt-3 space-y-3 pl-10 text-sm">
                      <StepBody s={s} busy={busy} act={act} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}

function Working({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-muted-foreground">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {text}
    </p>
  );
}

function StepBody({
  s,
  busy,
  act,
}: {
  s: Setup;
  busy: boolean;
  act: (b: object) => Promise<void>;
}) {
  const o = s.onboarding;
  if (o.state === "failed")
    return (
      <>
        <p role="alert" className="flex items-start gap-2 text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{o.error}</span>
        </p>
        <Button disabled={busy} onClick={() => act({ action: "retry" })}>
          Try again
        </Button>
      </>
    );
  if (o.state === "queued" || o.state === "running")
    return o.step === "clone" ? (
      <Working text={`Cloning ${s.repo} and reading its files…`} />
    ) : (
      <Working
        text={`Running install, build, lint and test on ${s.defaultBranch}. This can take a few minutes.`}
      />
    );
  switch (o.step) {
    case "commands":
      return <CommandsStep s={s} busy={busy} act={act} />;
    case "baseline":
      return <BaselineStep s={s} busy={busy} act={act} />;
    case "ci":
      return s.workflows?.length ? (
        <>
          <p>
            This repo already has CI on {s.defaultBranch}:{" "}
            {s.workflows.map((w) => (
              <code key={w} className="mr-1">
                {w}
              </code>
            ))}
          </p>
          <Button disabled={busy} onClick={() => act({ action: "skip-ci" })}>
            Continue
          </Button>
        </>
      ) : (
        <>
          <p>
            No CI workflow yet. Kanbot can open a pull request adding{" "}
            <code>.github/workflows/kanbot-ci.yml</code>: one job, <code>ci</code>, running the
            commands you confirmed
            {s.image ? (
              <>
                {" "}
                in <code>{s.image}</code>
              </>
            ) : null}
            . CI decides whether a PR can merge.
          </p>
          {s.env.length > 0 && (
            <p>
              The workflow reads {s.env.map((e) => e.name).join(", ")} from the repo&apos;s Actions
              secrets; Kanbot doesn&apos;t copy your values to GitHub.{" "}
              <a
                className="underline underline-offset-4"
                href={`https://github.com/${s.repo}/settings/secrets/actions`}
                target="_blank"
                rel="noreferrer"
              >
                Add them on GitHub
              </a>{" "}
              before merging the PR.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => act({ action: "open-ci-pr" })}>
              Open CI pull request
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => act({ action: "skip-ci" })}>
              Skip
            </Button>
          </div>
        </>
      );
    case "protection":
      return <ProtectionStep s={s} busy={busy} act={act} />;
    case "ready":
      return (
        <>
          <p>
            {o.override
              ? `Agents are on, without branch protection on ${s.defaultBranch} (your choice).`
              : `${s.defaultBranch} is protected. Agents are on.`}
          </p>
          <Link href={`/p/${s.id}`} className={buttonVariants()}>
            Open the board <ArrowRight aria-hidden className="size-4" />
          </Link>
        </>
      );
    case "clone": // shown as Working above
    default:
      return null;
  }
}

function CommandsStep({
  s,
  busy,
  act,
}: {
  s: Setup;
  busy: boolean;
  act: (b: object) => Promise<void>;
}) {
  const [commands, setCommands] = useState<Commands>(s.commands ?? {});
  const [image, setImage] = useState(s.image);
  const [globs, setGlobs] = useState(s.testGlobs.join("\n"));
  const [env, setEnv] = useState<EnvRow[]>(s.env);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void act({
          action: "confirm-commands",
          settings: {
            commands: Object.fromEntries(COMMANDS.map((c) => [c, commands[c] ?? ""])),
            image,
            testGlobs: globs
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            env: envBody(env),
          },
        });
      }}
    >
      <p className="text-muted-foreground">
        What Kanbot found in the repo. Edit anything that&apos;s wrong; leave a command empty if the
        project has none. One plain command each, no pipes or chaining. Start is required: QA runs
        the app the way you would (e.g. <code>npm run dev</code>), finds the port it listens on and
        checks each criterion against it.
      </p>
      {COMMANDS.map((c) => (
        <label key={c} className="block space-y-1">
          <span className="font-medium capitalize">{c}</span>
          <Input
            className="font-mono"
            value={commands[c] ?? ""}
            onChange={(e) => setCommands({ ...commands, [c]: e.target.value })}
            aria-describedby={c === "start" && !s.commands?.start ? "start-missing" : undefined}
          />
          {c === "start" && !s.commands?.start && (
            <span id="start-missing" className="block text-needs-fg">
              Not found in the repo. Required: the command that runs the app.
            </span>
          )}
        </label>
      ))}
      <label className="block space-y-1">
        <span className="font-medium">Image</span>
        <span className="block text-muted-foreground">
          {s.dockerfile ? (
            <>
              Empty: Kanbot builds the repo&apos;s <code>{s.dockerfile}</code>.
            </>
          ) : (
            "The Docker image the commands run in."
          )}
        </span>
        <Input className="font-mono" value={image} onChange={(e) => setImage(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="font-medium">Test globs</span>
        <span className="block text-muted-foreground">
          One per line; the files Testy McTestface may edit.
        </span>
        <Textarea
          className="font-mono"
          rows={3}
          value={globs}
          onChange={(e) => setGlobs(e.target.value)}
        />
      </label>
      <fieldset className="space-y-1">
        <legend className="font-medium">Environment variables</legend>
        <p className="text-muted-foreground">
          API keys and connection strings the commands need
          {s.env.length ? " (names from the repo's example env file)" : ""}. Stored encrypted and
          never shown again; use development credentials, since code the agents write can read them.
        </p>
        <EnvEditor rows={env} onChange={setEnv} />
      </fieldset>
      <Button type="submit" disabled={busy}>
        Confirm and run the baseline
      </Button>
    </form>
  );
}

function BaselineStep({
  s,
  busy,
  act,
}: {
  s: Setup;
  busy: boolean;
  act: (b: object) => Promise<void>;
}) {
  // jsonb keeps its own key order; show them in the order they ran.
  const results = (["install", "build", "lint", "test"] as const).flatMap((k) =>
    s.baseline?.[k] ? [[k, s.baseline[k]] as const] : [],
  );
  const failed = results.filter(([, r]) => !r.ok);
  return (
    <>
      {results.length === 0 ? (
        <p>No commands to run.</p>
      ) : (
        <ul className="space-y-2">
          {results.map(([k, r]) => (
            <li key={k}>
              <details>
                <summary className="flex cursor-pointer items-center gap-2">
                  {r.ok ? (
                    <Check aria-hidden className="size-4 text-ok-fg" />
                  ) : (
                    <CircleAlert aria-hidden className="size-4 text-failed-fg" />
                  )}
                  <span className="font-medium capitalize">{k}</span>
                  <code className="truncate text-muted-foreground">{r.command}</code>
                  <span className={r.ok ? "text-ok-fg" : "text-failed-fg"}>
                    {r.ok ? "passed" : "failed"}
                  </span>
                </summary>
                {r.output && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {r.output}
                  </pre>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && (
        <p className="text-muted-foreground">
          Accepting keeps these as a known baseline: Kanbot&apos;s checks skip{" "}
          {failed.length === 1 ? "this command" : "these commands"} and agents are told{" "}
          {failed.length === 1 ? "it was" : "they were"} already failing. Or fix the repo (or the
          command in Settings) and run it again.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => act({ action: "accept-baseline" })}>
          {failed.length ? "Accept as baseline" : "Continue"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => act({ action: "rerun-baseline" })}>
          Run again
        </Button>
        <Link href={`/p/${s.id}/settings`} className={buttonVariants({ variant: "ghost" })}>
          Settings
        </Link>
      </div>
    </>
  );
}

function ProtectionStep({
  s,
  busy,
  act,
}: {
  s: Setup;
  busy: boolean;
  act: (b: object) => Promise<void>;
}) {
  const p = s.protection;
  const ok = p && "missing" in p && p.missing.length === 0;
  return (
    <>
      {s.onboarding.ciPrUrl && (
        <p>
          CI pull request:{" "}
          <a href={s.onboarding.ciPrUrl} className="text-primary underline underline-offset-4">
            {s.onboarding.ciPrUrl.replace(/^https:\/\/github\.com\//, "")}
          </a>
          . Merge it on GitHub once <code>ci</code> passes.
        </p>
      )}
      {p && "error" in p ? (
        <p role="alert" className="text-destructive">
          GitHub refused to show the protection: {p.error}
        </p>
      ) : ok ? (
        <p>{s.defaultBranch} is already protected.</p>
      ) : (
        <>
          <p>
            {s.defaultBranch} lacks: {p?.missing.join(", ")}. Kanbot applies all of these, for
            admins too, so nothing reaches {s.defaultBranch} without a pull request you approve and
            green CI.
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => act({ action: "apply-protection" })}>
          {ok ? "Continue" : "Apply protection"}
        </Button>
        {!ok && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => act({ action: "override-protection" })}
          >
            Run agents without it
          </Button>
        )}
      </div>
    </>
  );
}
