"use client";

import { ArrowRight, FolderGit2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/brand";
import { SignOut, ThemeToggle } from "@/components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";

type Project = { id: string; name: string; keyPrefix: string };
type Repo = { owner: string; name: string; taken: boolean };

function KeyPrefix() {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">Key prefix (e.g. KB)</span>
      <Input
        name="keyPrefix"
        required
        pattern="[A-Za-z][A-Za-z0-9]{1,9}"
        className="font-mono uppercase"
      />
    </label>
  );
}

/** Home: projects and the new-project form. `agents` are the shipped agents (app/page.tsx reads their files);
 * `installUrl` is the GitHub App's install page, where the owner adds repos later (§10). */
export function Home({
  agents,
  installUrl,
}: {
  agents: { slug: string; name: string }[];
  installUrl?: string;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Project[]>("/api/projects").then(setProjects, (e: Error) => setError(e.message));
    api<Repo[]>("/api/github/repos").then(
      setRepos,
      (e: Error) => (setRepos([]), setError(e.message)),
    );
  }, []);

  async function create(form: FormData) {
    setError("");
    try {
      const p = await api<Project>("/api/projects", {
        body: {
          name: form.get("name"),
          keyPrefix: String(form.get("keyPrefix")).toUpperCase(),
          defaultBranch: form.get("defaultBranch") || undefined,
          repoPath: form.get("repoPath") || undefined,
        },
      });
      router.push(`/p/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** A GitHub repo: the project is created and onboarding (§10) continues on its setup page. */
  async function createFromGitHub(form: FormData) {
    setError("");
    const [githubOwner, githubRepo] = String(form.get("repo")).split("/");
    try {
      const p = await api<Project>("/api/projects", {
        body: {
          name: githubRepo,
          keyPrefix: String(form.get("keyPrefix")).toUpperCase(),
          githubOwner,
          githubRepo,
        },
      });
      router.push(`/p/${p.id}/setup`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 pb-16">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <div className="flex items-center gap-1">
          {installUrl && (
            <a
              href={installUrl}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              title="Pick which repos Kanbot's GitHub App can work on"
            >
              Add repos on GitHub
            </a>
          )}
          <ThemeToggle />
          <SignOut />
        </div>
      </header>
      <main className="grid gap-10 pt-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-10">
          <section className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Your board. <span className="text-primary">Their columns.</span>
            </h1>
            <p className="max-w-prose text-muted-foreground">
              Drop a ticket into a column and that column&apos;s agent picks it up: planning,
              building, review, tests. You approve the plan and the ship.
            </p>
            <ul aria-label="Agents" className="flex -space-x-2">
              {agents.map((a) => (
                <li key={a.slug}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- tiny local SVG */}
                  <img
                    src={`/api/agents/${a.slug}/avatar`}
                    alt={a.name}
                    title={a.name}
                    className="size-9 rounded-full ring-2 ring-background"
                  />
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="projects-h" className="space-y-3">
            <h2 id="projects-h" className="text-sm font-semibold text-muted-foreground">
              Projects
            </h2>
            {projects?.length === 0 && (
              <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
                No projects yet. Create one to get a board.
              </p>
            )}
            <ul className="grid gap-3 sm:grid-cols-2">
              {projects?.map((p) => (
                <li key={p.id}>
                  <Link
                    className="group flex items-center gap-3 rounded-xl border bg-card p-4 shadow-xs transition-[box-shadow,border-color] hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    href={`/p/${p.id}`}
                  >
                    <span className="grid size-10 place-items-center rounded-lg bg-primary/10 font-mono text-sm font-semibold text-primary">
                      {p.keyPrefix}
                    </span>
                    <span className="flex-1 font-medium">
                      {p.name} <span className="sr-only">({p.keyPrefix})</span>
                    </span>
                    <ArrowRight
                      aria-hidden
                      className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section
          className="h-fit space-y-4 rounded-xl border bg-card p-5 shadow-xs"
          aria-labelledby="new-h"
        >
          <h2 id="new-h" className="flex items-center gap-2 font-semibold">
            <FolderGit2 aria-hidden className="size-4 text-primary" />
            New project
          </h2>
          <form action={createFromGitHub} aria-label="From GitHub" className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">GitHub repo</span>
              <select
                name="repo"
                required
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                disabled={!repos?.length}
              >
                {repos === null && <option>Loading…</option>}
                {repos?.length === 0 && <option>No repos yet: add some on GitHub</option>}
                {repos?.map((r) => (
                  <option
                    key={`${r.owner}/${r.name}`}
                    value={`${r.owner}/${r.name}`}
                    disabled={r.taken}
                  >
                    {r.owner}/{r.name}
                    {r.taken ? " (already a project)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <KeyPrefix />
            <Button type="submit" className="w-full" disabled={!repos?.some((r) => !r.taken)}>
              Set up project
            </Button>
          </form>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Use a local folder instead
            </summary>
            <form action={create} aria-label="Local folder" className="mt-3 space-y-4">
              <p className="text-xs text-muted-foreground">
                No GitHub: agents plan, build, review and test, but nothing ships as a pull request.
              </p>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Name</span>
                <Input name="name" required maxLength={100} />
              </label>
              <KeyPrefix />
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Default branch</span>
                <Input name="defaultBranch" placeholder="main" className="font-mono" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Local repo path (optional)</span>
                <Input name="repoPath" placeholder="/home/you/code/my-app" className="font-mono" />
                <span className="block text-xs text-muted-foreground">
                  Plan B reads this checkout. Without one it plans from the ticket alone.
                </span>
              </label>
              <Button type="submit" variant="outline" className="w-full">
                Create project
              </Button>
            </form>
          </details>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
