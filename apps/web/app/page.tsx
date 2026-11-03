"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";

type Project = { id: string; name: string; keyPrefix: string };

export default function Home() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Project[]>("/api/projects").then(setProjects, (e: Error) => setError(e.message));
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

  return (
    <main className="mx-auto max-w-xl space-y-8 p-8">
      <h1 className="text-2xl font-semibold">Kanbot</h1>
      <section aria-labelledby="projects-h" className="space-y-2">
        <h2 id="projects-h" className="font-medium">
          Projects
        </h2>
        {projects?.length === 0 && <p className="text-muted-foreground">No projects yet.</p>}
        <ul className="space-y-1">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link className="underline" href={`/p/${p.id}`}>
                {p.name} <span className="text-muted-foreground">({p.keyPrefix})</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <form action={create} className="space-y-3" aria-labelledby="new-h">
        <h2 id="new-h" className="font-medium">
          New project
        </h2>
        <label className="block space-y-1">
          <span className="text-sm">Name</span>
          <Input name="name" required maxLength={100} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Key prefix (e.g. KB)</span>
          <Input name="keyPrefix" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Default branch</span>
          <Input name="defaultBranch" placeholder="main" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Local repo path (optional)</span>
          <Input name="repoPath" placeholder="/home/you/code/my-app" />
          <span className="block text-xs text-muted-foreground">
            Plan B reads this checkout. Without one it plans from the ticket alone.
          </span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit">Create project</Button>
      </form>
    </main>
  );
}
