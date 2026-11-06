import { exec, execFile, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { uuidv7 } from "@kanbot/shared";
import { branchName, git, type ProjectConfig } from "@kanbot/shared/repo";

const sh = promisify(exec);
const execFileP = promisify(execFile);

/** Columns whose agents work in the ticket's worktree (FR-40); earlier columns use the checkout. */
export const WORKTREE_COLUMNS = new Set(["in_progress", "code_review", "qa"]);

/** Worktrees live beside the checkout, never inside it: `<repo>.kanbot-worktrees/<KEY-n>` (§7). */
export const worktreesRoot = (repoPath: string) => `${resolve(repoPath)}.kanbot-worktrees`;

type Ticket = { key: string; title: string; branchName: string | null };

/**
 * Creates the ticket's worktree and branch on first use, or reuses them (FR-40). Never touches the
 * default branch or any branch outside `kanbot/`. Runs the project's install command after creating.
 */
export async function ensureWorktree(
  repoPath: string,
  defaultBranch: string,
  ticket: Ticket,
  config: ProjectConfig,
): Promise<{ path: string; branch: string }> {
  const branch = ticket.branchName ?? branchName(ticket.key, ticket.title);
  const root = worktreesRoot(repoPath);
  const path = join(root, ticket.key);
  if (!branch.startsWith("kanbot/") || relative(root, path).startsWith(".."))
    throw new Error(`Refusing worktree ${path} on branch ${branch}`);

  if (existsSync(path)) {
    const head = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (head !== branch) throw new Error(`Worktree ${path} is on ${head}, expected ${branch}`);
    // Agents can change dependencies; install again when the lockfile differs from the last install (§8 step 2).
    // A failed reinstall keeps the worktree: it may hold the agent's work.
    if (config.commands.install && (await lockfileHash(path)) !== (await installedHash(path))) {
      await install(config.commands.install, path, config.image);
    }
    return { path, branch };
  }
  await git(repoPath, ["worktree", "prune"]); // forget worktrees whose folder was deleted
  const exists = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
  await git(
    repoPath,
    exists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, defaultBranch],
  );
  // A failed install removes the worktree again (the branch stays), so the next run installs anew.
  if (config.commands.install)
    await install(config.commands.install, path, config.image).catch(async (e: Error) => {
      await git(repoPath, ["worktree", "remove", "--force", path]).catch(() => {});
      throw e;
    });
  return { path, branch };
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"];

/** Hash of the lockfiles that exist; "" if there are none. */
async function lockfileHash(path: string) {
  const present = LOCKFILES.filter((f) => existsSync(join(path, f)));
  const hashes = await Promise.all(present.map((f) => git(path, ["hash-object", f])));
  return hashes.map((h, i) => `${present[i]}:${h.trim()}`).join("\n");
}

/** The marker lives in the worktree's git dir, so it never shows up as a change in the work tree. */
const markerPath = async (path: string) =>
  resolve(path, (await git(path, ["rev-parse", "--git-path", "kanbot-install"])).trim());

async function installedHash(path: string) {
  try {
    return readFileSync(await markerPath(path), "utf8");
  } catch {
    return null; // worktrees from before this marker existed install once more
  }
}

async function install(command: string, path: string, image?: string) {
  const hash = await lockfileHash(path);
  await runCommand(command, path, image).catch((e: Error) => {
    throw new Error(`Install failed (${command}): ${e.message}`);
  });
  writeFileSync(await markerPath(path), hash);
}

/** Lines of a failing check's output kept for the report. */
const CHECK_TAIL_LINES = 200;

/**
 * The checks gate (§8): the project's build, lint and test commands, in that order, after Sir Codes-a-Lot
 * reports success. Stops at the first failure and returns it with the tail of its output; null if all pass.
 */
export async function runChecks(commands: ProjectConfig["commands"], path: string, image?: string) {
  for (const command of [commands.build, commands.lint, commands.test]) {
    if (!command) continue;
    try {
      await runCommand(command, path, image);
    } catch (e) {
      const err = e as Error & { stdout?: string; stderr?: string; killed?: boolean };
      const text = [err.stdout, err.stderr].filter(Boolean).join("\n").trimEnd();
      const output =
        (err.killed ? "Killed after 10 minutes.\n" : "") +
        (text ? text.split("\n").slice(-CHECK_TAIL_LINES).join("\n") : err.message);
      return { command, output };
    }
  }
  return null;
}

/** The environment project commands get: the worker's, minus its credentials. */
function commandEnv() {
  const { DATABASE_URL: _db, ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return env;
}

const APP_READY_MS = 60_000;

/**
 * Starts the project's app for a QA run (§4) on a free port, and waits until it answers HTTP on
 * 127.0.0.1. Returns its URL and a stop(), or why it didn't come up (with the output's tail).
 * With an image, the app runs in a container whose port is published on 127.0.0.1 only (§7); it must
 * listen on all interfaces inside the container (Node's default).
 */
export async function startApp(
  command: string,
  cwd: string,
  image?: string,
): Promise<{ url: string; stop: () => Promise<void> } | { error: string }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const name = `kanbot-qa-${uuidv7()}`;
  // Pull first, so a first-time download doesn't eat the 60 s the app gets to come up.
  if (image) {
    const pull = await execFileP("docker", ["image", "inspect", image])
      .catch(() => execFileP("docker", ["pull", image], { timeout: 10 * 60_000 }))
      .then(
        () => null,
        (e: Error) => e.message,
      );
    if (pull) return { error: `Could not pull ${image}: ${pull}` };
  }
  const child = image
    ? spawn("docker", dockerRun(image, cwd, command, { name, port }), { windowsHide: true })
    : spawn(command, {
        cwd,
        env: { ...commandEnv(), PORT: String(port) },
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32", // own process group, so stop() reaches the shell's children
      });
  let output = "";
  const keep = (b: Buffer) => (output = (output + b.toString()).slice(-8_000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited = child.exitCode !== null;
  const done = new Promise<void>((r) => child.once("exit", () => ((exited = true), r())));
  const stop = async () => {
    if (exited) return;
    if (image) await removeContainers(["--filter", `name=${name}`]);
    else if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid!, "SIGKILL");
    await done;
  };
  const tail = () => output.trimEnd().split("\n").slice(-CHECK_TAIL_LINES).join("\n");
  for (const end = Date.now() + APP_READY_MS; Date.now() < end;) {
    if (exited) return { error: `\`${command}\` exited before answering on ${url}:\n${tail()}` };
    const up = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      .then(() => true)
      .catch(() => false);
    if (up) return { url, stop };
    await new Promise((r) => setTimeout(r, 250));
  }
  await stop();
  return { error: `\`${command}\` didn't answer on ${url} within 60 s:\n${tail()}` };
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => ok(port));
    });
  });
}

/**
 * A project command, run by the worker itself (install, the checks gate): in the project's image when it
 * has one (§7), else on the worker's toolchain with the same scrubbed env agents get.
 */
async function runCommand(command: string, cwd: string, image?: string) {
  const opts = { cwd, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 };
  if (!image) return void (await sh(command, { ...opts, env: commandEnv() }));
  const name = `kanbot-${uuidv7()}`;
  // A timeout kills the docker CLI, not the container, so remove it by name whatever happened.
  await execFileP("docker", dockerRun(image, cwd, command, { name }), opts).finally(() =>
    removeContainers(["--filter", `name=${name}`]),
  );
}

/** Where a host folder is mounted in a container: the same path, so paths in output and errors match. */
const mountPath = (p: string) =>
  // shortcut: Windows (dev only) mounts C:\a at /c/a; the server is Linux, where the path is unchanged.
  process.platform === "win32" ? `/${p[0]!.toLowerCase()}${p.slice(2).replaceAll("\\", "/")}` : p;

/** Label on every container Kanbot starts, so they can be found and removed (`kanbot.run=<run id>` for agents'). */
const LABEL = "kanbot";

/**
 * `docker run` arguments for one project command in the project's image (§7): only the worktree is
 * mounted, plus a shared cache volume as HOME, and no host environment reaches the container. The image
 * is a validated reference (`IMAGE_REF`), so it can't be read as a docker option.
 */
export function dockerRun(
  image: string,
  cwd: string,
  command: string,
  o: { name?: string; port?: number; label?: string } = {},
) {
  const dir = mountPath(cwd);
  return [
    "run",
    "--rm",
    "--init", // signals reach the command, and it reaps its children
    "--label",
    o.label ? `${LABEL}=${o.label}` : LABEL,
    ...(o.name ? ["--name", o.name] : []),
    "-v",
    `${cwd}:${dir}`,
    "-w",
    dir,
    "-v",
    "kanbot-cache:/cache",
    "-e",
    "HOME=/cache",
    ...(o.port ? ["-e", `PORT=${o.port}`, "-p", `127.0.0.1:${o.port}:${o.port}`] : []),
    image,
    "sh",
    "-c",
    command,
  ];
}

/** Removes the containers a `docker ps` filter matches (e.g. a run's leftovers). Never throws. */
export async function removeContainers(filter: string[]) {
  try {
    const ids = (await execFileP("docker", ["ps", "-aq", ...filter])).stdout
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length) await execFileP("docker", ["rm", "-f", ...ids]);
  } catch (e) {
    console.warn(`Could not remove containers (${filter.join(" ")}): ${(e as Error).message}`);
  }
}

/** POSIX shell quoting, for a command line the agent's Bash tool runs. */
export const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The agent's Bash call, rewritten to run in the project's image when it is one of the project's own
 * commands (with any arguments); null for every other command (git, …), which stays on the host.
 * Containers carry the run's id, so `removeContainers` can clear any the Bash tool's timeout left behind.
 */
export function containerBash(
  image: string,
  cwd: string,
  commands: ProjectConfig["commands"],
  runId: string,
) {
  const own = [commands.install, commands.build, commands.test, commands.lint].filter(
    (c): c is string => !!c,
  );
  return (cmd: string) => {
    const c = cmd.trim().replace(/\s+/g, " ");
    if (!own.some((o) => c === o || c.startsWith(`${o} `))) return null;
    const line = ["docker", ...dockerRun(image, cwd, c, { label: runId })].map(shQuote).join(" ");
    // Git Bash (the Bash tool on Windows, dev only) would turn the /c/… mount path back into C:/….
    return process.platform === "win32" ? `MSYS_NO_PATHCONV=1 ${line}` : line;
  };
}

/** Uncommitted and untracked files (porcelain paths, repo-relative, forward slashes). */
async function dirtyFiles(path: string) {
  const status = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
  return status
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, ""));
}

/** Snapshot before a run, for the post-run checks. */
export async function snapshot(path: string, defaultBranch: string) {
  const [head, main, dirty] = await Promise.all([
    git(path, ["rev-parse", "HEAD"]),
    git(path, ["rev-parse", `refs/heads/${defaultBranch}`]),
    dirtyFiles(path),
  ]);
  return { head: head.trim(), main: main.trim(), dirty };
}

/** Files changed since `base`, committed or not. */
export async function changedSince(path: string, base: string) {
  const [committed, dirty] = await Promise.all([
    git(path, ["diff", "--name-only", base, "HEAD"]),
    dirtyFiles(path),
  ]);
  return [...new Set([...committed.split("\n").filter(Boolean), ...dirty])];
}

/**
 * Post-run checks (requirements §8, §14). Returns why the run must fail, or null. Nothing is reverted:
 * the commits stay on the branch for the owner to inspect.
 */
export async function checkAfterRun(
  wt: { path: string; branch: string },
  defaultBranch: string,
  before: { head: string; main: string; dirty: string[] },
  canEdit: ((rel: string) => boolean) | undefined,
): Promise<string | null> {
  const head = (await git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (head !== wt.branch)
    return `The worktree was switched to ${head}; agents must stay on ${wt.branch}`;
  const after = await snapshot(wt.path, defaultBranch);
  // The owner may commit to the default branch while agents work; only the run's own commits landing
  // there count. (The fence keeps agents from reaching it at all; this is the second check.)
  if (after.main !== before.main) {
    const range = (from: string, to: string) =>
      git(wt.path, ["rev-list", `${from}..${to}`]).then((s) => s.split("\n").filter(Boolean));
    const [onMain, mine] = await Promise.all([
      range(before.main, after.main),
      range(before.head, after.head),
    ]);
    if (onMain.some((c) => mine.includes(c)))
      return `This run's commits reached the default branch ${defaultBranch}`;
  }
  const kept = await git(wt.path, ["merge-base", "--is-ancestor", before.head, after.head])
    .then(() => true)
    .catch(() => false);
  if (!kept) return "Commits that existed before the run were rewritten (amend, reset or rebase)";
  // A run answers only for what it changed: files a previous run left dirty aren't this run's.
  // shortcut: a file that was already dirty and this run edits further isn't caught; hash dirty files if that matters.
  const changed = (await changedSince(wt.path, before.head)).filter(
    (f) => !before.dirty.includes(f),
  );
  const settings = changed.find((f) => f.startsWith(".kanbot/"));
  if (settings) return `Agents may not change Kanbot settings (${settings})`;
  const outside = canEdit && changed.filter((f) => !canEdit(f));
  if (outside?.length)
    return `Changed files outside this agent's edit scope: ${outside.join(", ")}`;
  return null;
}
