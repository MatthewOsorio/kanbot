import { exec, execFile, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { IMAGE_REF, uuidv7 } from "@kanbot/shared";
import type { Baseline } from "@kanbot/shared/onboarding";
import { branchName, git, type ProjectConfig } from "@kanbot/shared/repo";

const sh = promisify(exec);
const execFileP = promisify(execFile);

/** Columns whose agents work in the ticket's worktree (FR-40); earlier columns use the checkout. */
export const WORKTREE_COLUMNS = new Set(["in_progress", "code_review", "qa", "ship"]);

/** Worktrees live beside the checkout, never inside it: `<repo>.kanbot-worktrees/<KEY-n>` (§7). */
export const worktreesRoot = (repoPath: string) => `${resolve(repoPath)}.kanbot-worktrees`;

type Ticket = { key: string; title: string; branchName: string | null };

/**
 * The project's env vars (§10) for its commands: `vars` for the worker's toolchain, `file` (docker's
 * --env-file) for containers, so values never appear in a command line. Empty values (names not set yet)
 * are left out.
 */
export type ProjectEnv = { vars: Record<string, string>; file?: string };
const NO_ENV: ProjectEnv = { vars: {} };

/**
 * Writes the env file (mode 0600) to a fresh folder outside every worktree, where agents can't read it
 * (fence.ts refuses paths outside the run's cwd). Call dispose() when the run or step ends.
 */
export async function openEnv(
  all: Record<string, string>,
): Promise<ProjectEnv & { dispose: () => Promise<void> }> {
  const vars = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== ""));
  if (!Object.keys(vars).length) return { vars, dispose: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "kanbot-env-"));
  const file = join(dir, "env");
  const lines = Object.entries(vars).map(
    ([k, v]) => `${k}=${v}
`,
  );
  await writeFile(file, lines.join(""), { mode: 0o600 });
  return { vars, file, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Creates the ticket's worktree and branch on first use, or reuses them (FR-40). Never touches the
 * default branch or any branch outside `kanbot/`. Runs the project's install command after creating.
 */
export async function ensureWorktree(
  repoPath: string,
  defaultBranch: string,
  ticket: Ticket,
  config: ProjectConfig,
  env: ProjectEnv = NO_ENV,
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
      await install(config.commands.install, path, config.image, env);
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
    await install(config.commands.install, path, config.image, env).catch(async (e: Error) => {
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

async function install(command: string, path: string, image?: string, env = NO_ENV) {
  const hash = await lockfileHash(path);
  await runCommand(command, path, image, env).catch((e: Error) => {
    throw new Error(`Install failed (${command}): ${e.message}`);
  });
  writeFileSync(await markerPath(path), hash);
}

/** Lines of a failing check's output kept for the report. */
const CHECK_TAIL_LINES = 200;

/** Runs one project command; null if it passed, else the tail of its output. */
async function tryCommand(command: string, path: string, image?: string, env = NO_ENV) {
  try {
    await runCommand(command, path, image, env);
    return null;
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string; killed?: boolean };
    const text = [err.stdout, err.stderr].filter(Boolean).join("\n").trimEnd();
    return (
      (err.killed ? "Killed after 10 minutes.\n" : "") +
      (text ? text.split("\n").slice(-CHECK_TAIL_LINES).join("\n") : err.message)
    );
  }
}

/**
 * The checks gate (§8): the project's build, lint and test commands, in that order, after Sir Codes-a-Lot
 * reports success. Stops at the first failure and returns it with the tail of its output; null if all pass.
 * `skip`: commands that already failed on the default branch at onboarding (the baseline, §10 step 5).
 */
export async function runChecks(
  commands: ProjectConfig["commands"],
  path: string,
  image?: string,
  skip: string[] = [],
  env = NO_ENV,
) {
  for (const command of [commands.build, commands.lint, commands.test]) {
    if (!command || skip.includes(command)) continue;
    const output = await tryCommand(command, path, image, env);
    if (output !== null) return { command, output };
  }
  return null;
}

/** The baseline (§10 step 5): install, build, lint and test once, each run whatever the others did. */
export async function runBaseline(
  commands: ProjectConfig["commands"],
  path: string,
  image?: string,
  env = NO_ENV,
) {
  if (image) await pullImage(image);
  const out: Baseline = {};
  for (const k of ["install", "build", "lint", "test"] as const) {
    const command = commands[k];
    if (!command) continue;
    const output = await tryCommand(command, path, image, env);
    out[k] = { command, ok: output === null, output: output ?? "" };
  }
  return out;
}

/** The environment project commands get: the worker's, minus its credentials. */
function commandEnv() {
  const { DATABASE_URL: _db, ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return env;
}

/** The sidecar that owns a QA app's network and forwards to whatever port the app listens on (§4). */
export const FORWARDER_IMAGE = "alpine/socat:1.8.0.3";
/** The forwarder's port inside the app's network namespace; the host's 127.0.0.1:<port> maps to it. */
const FORWARD_PORT = 39999;

/**
 * The TCP ports listening in a network namespace, from `/proc/net/tcp` and `/proc/net/tcp6` lines
 * (`sl local_address rem_address st …`, address `HEXIP:HEXPORT`, state 0A = LISTEN).
 */
export function listeningPorts(procNetTcp: string): number[] {
  const ports = new Set<number>();
  for (const line of procNetTcp.split("\n")) {
    const [, local, , st] = line.trim().split(/\s+/);
    if (st !== "0A" || !local?.includes(":")) continue;
    ports.add(parseInt(local.split(":").at(-1)!, 16));
  }
  return [...ports].sort((a, b) => a - b);
}

/** The app's port: the PORT it was given if it listens there, else the lowest other one. */
export const appPort = (ports: number[], given: number) =>
  ports.includes(given) ? given : ports.find((p) => p !== FORWARD_PORT);

const APP_READY_MS = 60_000;

/**
 * Starts the project's app for a QA run (§4) and waits until it answers HTTP on 127.0.0.1:<free port>.
 * Returns its URL and a stop(), or why it didn't come up (with the output's tail).
 *
 * With an image (§7) the app may listen on any port and any host, as `npm run dev` does on a laptop:
 * a forwarder container owns the network namespace (published on 127.0.0.1 only), the app joins it,
 * and once a port is listening there the forwarder relays to it from inside, so a localhost-only
 * dev server (Vite, Django, …) is reachable too. Each app has its own namespace, so ports never collide.
 * shortcut: without an image (dev only) the app runs on the host and must listen on PORT; production always has an image.
 */
export async function startApp(
  command: string,
  cwd: string,
  image?: string,
  env = NO_ENV,
): Promise<{ url: string; stop: () => Promise<void> } | { error: string }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // Filled in here, not by a shell: cmd.exe (the host path on Windows) doesn't expand $PORT.
  command = command.replace(/\$PORT\b/g, String(port));
  const name = `kanbot-qa-${uuidv7()}`;
  const fwd = `${name}-fwd`; // matched by stop()'s name filter too
  if (image) {
    // Pull first, so a first-time download doesn't eat the 60 s the app gets to come up.
    for (const i of [image, FORWARDER_IMAGE]) {
      const pull = await pullImage(i).then(
        () => null,
        (e: Error) => e.message,
      );
      if (pull) return { error: pull };
    }
    const started = await execFileP("docker", [
      "run",
      "-d",
      "--rm",
      "--label",
      LABEL,
      "--name",
      fwd,
      "-p",
      `127.0.0.1:${port}:${FORWARD_PORT}`,
      "--entrypoint",
      "sleep",
      FORWARDER_IMAGE,
      "infinity",
    ]).then(
      () => null,
      (e: Error) => e.message,
    );
    if (started) return { error: `Could not start the app's network: ${started}` };
  }
  const child = image
    ? spawn(
        "docker",
        dockerRun(image, cwd, command, { name, port, network: fwd, envFile: env.file }),
        { windowsHide: true },
      )
    : spawn(command, {
        cwd,
        env: { ...commandEnv(), ...env.vars, PORT: String(port) },
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
    // The app and its forwarder; removing the app also ends the docker CLI.
    if (image) await removeContainers(["--filter", `name=${name}`]);
    else if (exited) return;
    else if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid!, "SIGKILL");
    await done;
  };
  const tail = () => output.trimEnd().split("\n").slice(-CHECK_TAIL_LINES).join("\n");
  let listening: number[] = [];
  let forwarding: number | undefined = image ? undefined : port;
  const seen = () =>
    image
      ? `\nListening in the container: ${listening.length ? listening.join(", ") : "nothing"}`
      : "";
  for (const end = Date.now() + APP_READY_MS; Date.now() < end;) {
    if (exited) {
      await stop();
      return { error: `\`${command}\` exited before answering on ${url}:\n${tail()}` };
    }
    if (forwarding === undefined) {
      const read = (f: string) =>
        execFileP("docker", ["exec", fwd, "cat", f]).then(
          (r) => listeningPorts(r.stdout),
          (): number[] => [],
        );
      const [v4, v6] = await Promise.all([read("/proc/net/tcp"), read("/proc/net/tcp6")]);
      listening = [...new Set([...v4, ...v6])].sort((a, b) => a - b);
      const target = appPort(listening, port);
      if (target !== undefined) {
        await execFileP("docker", [
          "exec",
          "-d",
          fwd,
          "socat",
          `TCP-LISTEN:${FORWARD_PORT},fork,reuseaddr`,
          // Node's "localhost" is often [::1] only (Vite); an IPv6 wildcard takes [::1] too.
          v4.includes(target) ? `TCP:127.0.0.1:${target}` : `TCP6:[::1]:${target}`,
        ]).then(
          () => (forwarding = target),
          () => undefined, // retried on the next pass
        );
      }
    }
    const up =
      forwarding !== undefined &&
      (await fetch(url, { signal: AbortSignal.timeout(2_000) })
        .then(() => true)
        .catch(() => false));
    if (up) return { url, stop };
    await new Promise((r) => setTimeout(r, 250));
  }
  await stop();
  return { error: `\`${command}\` didn't answer on ${url} within 60 s:${seen()}\n${tail()}` };
}

/**
 * Makes sure the image is local. Called before a run's first project command, so a failed download fails
 * the run instead of passing for a failing check (which would bounce the ticket to the agent).
 */
export async function pullImage(image: string) {
  await execFileP("docker", ["image", "inspect", image])
    .catch(() => execFileP("docker", ["pull", image], { timeout: 10 * 60_000 }))
    .catch((e: Error) => {
      throw new Error(`Could not pull ${image}: ${e.message}`);
    });
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
async function runCommand(command: string, cwd: string, image?: string, env = NO_ENV) {
  const opts = { cwd, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 };
  if (!image) return void (await sh(command, { ...opts, env: { ...commandEnv(), ...env.vars } }));
  const name = `kanbot-${uuidv7()}`;
  // A timeout kills the docker CLI, not the container, so remove it by name whatever happened.
  await execFileP(
    "docker",
    dockerRun(image, cwd, command, { name, envFile: env.file }),
    opts,
  ).finally(() => removeContainers(["--filter", `name=${name}`]));
}

/** Where a host folder is mounted in a container: the same path, so paths in output and errors match. */
const mountPath = (p: string) =>
  // shortcut: Windows (dev only) mounts C:\a at /c/a; the server is Linux, where the path is unchanged.
  process.platform === "win32" ? `/${p[0]!.toLowerCase()}${p.slice(2).replaceAll("\\", "/")}` : p;

/** Label on every container Kanbot starts, so they can be found and removed (`kanbot.run=<run id>` for agents'). */
const LABEL = "kanbot";

/**
 * `docker run` arguments for one project command in the project's image (§7): only the worktree is
 * mounted, plus a shared cache volume as HOME, and no host environment reaches the container (only the
 * project's own env vars, from `envFile`). The image
 * is a validated reference (`IMAGE_REF`), so it can't be read as a docker option.
 */
export function dockerRun(
  image: string,
  cwd: string,
  command: string,
  o: { name?: string; port?: number; network?: string; label?: string; envFile?: string } = {},
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
    ...(o.envFile ? ["--env-file", o.envFile] : []), // the project's env vars (§10), never in argv
    ...(o.network ? ["--network", `container:${o.network}`] : []), // QA's app: its forwarder's namespace
    ...(o.port ? ["-e", `PORT=${o.port}`] : []),
    image,
    "sh",
    "-c",
    command,
  ];
}

const BUILD_MS = 20 * 60_000;

/**
 * The image to run project commands in (§7): the owner's Image if set, else the one the repo's
 * devcontainer Dockerfile builds, else KANBOT_DEFAULT_IMAGE, else none (the worker's toolchain). The build always comes from the
 * default branch (`git archive`), never a worktree, so agents can't change it; its tag is the context's
 * tree hash, so it rebuilds only when the context changes there.
 */
export async function projectImage(
  repoPath: string,
  defaultBranch: string,
  config: Pick<ProjectConfig, "image" | "dockerfile">,
  key: string,
): Promise<string | undefined> {
  if (config.image) return config.image;
  if (!config.dockerfile) return defaultImage();
  const { file, context } = config.dockerfile;
  const inContext = context === "." ? file : posix.relative(context, file);
  if (inContext.startsWith("../"))
    throw new Error(
      `The devcontainer's Dockerfile ${file} is outside its build context ${context}`,
    );
  const tree = `${defaultBranch}:${context === "." ? "" : context}`;
  const hash = (await git(repoPath, ["rev-parse", tree])).trim().slice(0, 12);
  const tag = `kanbot-${key.toLowerCase().replace(/[^a-z0-9]/g, "")}:${hash}`;
  const built = await execFileP("docker", ["image", "inspect", tag]).then(
    () => true,
    () => false,
  );
  if (!built) await buildImage(repoPath, tree, inContext, tag);
  return tag;
}

/**
 * KANBOT_DEFAULT_IMAGE, for projects with no image of their own. Set by docker-compose.yml, so a
 * containerized worker never runs project code beside its Docker socket; unset in development, where
 * those projects use the host's toolchain.
 */
function defaultImage() {
  const image = process.env.KANBOT_DEFAULT_IMAGE?.trim();
  if (image && !IMAGE_REF.test(image))
    throw new Error(`KANBOT_DEFAULT_IMAGE "${image}" is not an image reference`);
  return image || undefined;
}

/** `git archive <tree> | docker build -f <file> -t <tag> -`, without a shell. Throws with the output's tail. */
function buildImage(repoPath: string, tree: string, file: string, tag: string) {
  return new Promise<void>((ok, fail) => {
    const archive = spawn("git", ["archive", "--format=tar", tree], {
      cwd: repoPath,
      windowsHide: true,
    });
    const build = spawn("docker", ["build", "--label", LABEL, "-f", file, "-t", tag, "-"], {
      windowsHide: true,
    });
    archive.on("error", fail);
    build.on("error", fail);
    build.stdin.on("error", () => {}); // docker exiting early is reported by its exit code
    archive.stdout.pipe(build.stdin);
    let output = "";
    const keep = (b: Buffer) => (output = (output + b.toString()).slice(-8_000));
    archive.stderr.on("data", keep);
    build.stdout.on("data", keep);
    build.stderr.on("data", keep);
    const timer = setTimeout(() => (archive.kill(), build.kill()), BUILD_MS);
    build.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return ok();
      const tail = output.trimEnd().split("\n").slice(-CHECK_TAIL_LINES).join("\n");
      fail(new Error(`Building the devcontainer image ${tag} failed:\n${tail}`));
    });
  });
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
  envFile?: string,
) {
  const own = [commands.install, commands.build, commands.test, commands.lint].filter(
    (c): c is string => !!c,
  );
  return (cmd: string) => {
    const c = cmd.trim().replace(/\s+/g, " ");
    if (!own.some((o) => c === o || c.startsWith(`${o} `))) return null;
    // On Windows (dev only) the SDK runtime sets MSYS_NO_PATHCONV in the agent's environment: a
    // `VAR=… docker` prefix here is refused by Claude Code's own permission check.
    return ["docker", ...dockerRun(image, cwd, c, { label: runId, envFile })]
      .map(shQuote)
      .join(" ");
  };
}

/**
 * An agent's `git commit`, rewritten to carry the `Kanbot-Agent` and `Kanbot-Ticket` trailers and, on a
 * GitHub project, the App's bot as author (FR-42); null for every other command. The fence has already
 * checked the agent's own command, which can't pass `-c` itself.
 */
export function commitAs(agent: string, ticket: string, bot?: { name: string; email: string }) {
  return (cmd: string) => {
    const m = /^git\s+commit(\s.*)?$/s.exec(cmd.trim());
    if (!m) return null;
    const who = bot
      ? ` -c ${shQuote(`user.name=${bot.name}`)} -c ${shQuote(`user.email=${bot.email}`)}`
      : "";
    // Right after `commit`, so a trailing `-- <paths>` can't turn the trailers into pathspecs.
    return `git${who} commit --trailer ${shQuote(`Kanbot-Agent: ${agent}`)} --trailer ${shQuote(`Kanbot-Ticket: ${ticket}`)}${m[1] ?? ""}`;
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
