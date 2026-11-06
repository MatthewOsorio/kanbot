// Server-only: git, the project's .kanbot/project.yml, and the overlap check (requirements §9, §14).
import { execFile } from "node:child_process";
import { matchesGlob } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";

const run = promisify(execFile);

/** Runs git without a shell (arguments are never interpreted). Throws with git's stderr on failure. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).trim()}`);
  }
}

/** FR-49: removes a ticket's worktree; the branch stays (it may hold work worth keeping). Never throws. */
export const removeWorktree = (repoPath: string, path: string) =>
  git(repoPath, ["worktree", "remove", "--force", path]).then(
    () => true,
    (e: Error) => {
      console.warn(`Could not remove worktree ${path}: ${e.message}`);
      return false;
    },
  );

/** `.kanbot/project.yml` (requirements §9). Settings UI and DB columns arrive with Settings (M4). */
export const projectConfig = z.object({
  commands: z
    .object({
      install: z.string().trim().min(1).optional(),
      build: z.string().trim().min(1).optional(),
      test: z.string().trim().min(1).optional(),
      lint: z.string().trim().min(1).optional(),
      /** Starts the app for QA (§4): the worker runs it with PORT set and waits for an HTTP answer. */
      start: z.string().trim().min(1).optional(),
    })
    .default({}),
  testGlobs: z.array(z.string().min(1)).default([]),
  hotspots: z
    .array(z.object({ name: z.string().min(1), paths: z.array(z.string().min(1)) }))
    .default([]),
});
export type ProjectConfig = z.output<typeof projectConfig>;

/**
 * Read from the default branch, never a working copy: an agent editing the file on its branch can't
 * widen its own allowlist; the change only counts once the owner merges it.
 */
export async function loadProjectConfig(repoPath: string, defaultBranch: string) {
  let text: string;
  try {
    text = await git(repoPath, ["show", `${defaultBranch}:.kanbot/project.yml`]);
  } catch {
    return projectConfig.parse({});
  }
  return projectConfig.parse(parse(text) ?? {});
}

/** Does one touch entry (path or glob) cover another? Folder entries end with "/". */
function touches(a: string, b: string) {
  // shortcut: glob-vs-glob is approximate (each side is tried as a pattern against the other); use a glob-intersection library if it misjudges real touch sets.
  return (
    a === b ||
    matchesGlob(a, b) ||
    matchesGlob(b, a) ||
    (a.endsWith("/") && b.startsWith(a)) ||
    (b.endsWith("/") && a.startsWith(b))
  );
}

/** What two tickets' touch sets share: paths, and hotspot groups both touch (§9 overlap check). */
export function overlap(
  a: readonly string[],
  b: readonly string[],
  hotspots: ProjectConfig["hotspots"],
) {
  const files = a.filter((x) => b.some((y) => touches(x, y)));
  const groups = hotspots
    .filter((h) => [a, b].every((set) => set.some((p) => h.paths.some((g) => touches(p, g)))))
    .map((h) => h.name);
  return { files, hotspots: groups };
}

/** `kanbot/KB-12-short-slug` (requirements §2 worktree). */
export const branchName = (key: string, title: string) =>
  `kanbot/${key}-${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/, "") || "ticket"
  }`;
