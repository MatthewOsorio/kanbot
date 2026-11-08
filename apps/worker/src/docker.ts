// Project commands' containers (§7): which image, building it, and the `docker run` line.
import { execFile, spawn } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { IMAGE_REF } from "@kanbot/shared";
import { git, type ProjectConfig } from "@kanbot/shared/repo";

const execFileP = promisify(execFile);

/** Lines of a failing check's output kept for the report. */
const CHECK_TAIL_LINES = 200;
export const tailOf = (output: string) =>
  output.trimEnd().split("\n").slice(-CHECK_TAIL_LINES).join("\n");

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

/** Where a host folder is mounted in a container: the same path, so paths in output and errors match. */
const mountPath = (p: string) =>
  // shortcut: Windows (dev only) mounts C:\a at /c/a; the server is Linux, where the path is unchanged.
  process.platform === "win32" ? `/${p[0]!.toLowerCase()}${p.slice(2).replaceAll("\\", "/")}` : p;

/** Label on every container Kanbot starts, so they can be found and removed (`kanbot.run=<run id>` for agents'). */
export const LABEL = "kanbot";

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
      fail(new Error(`Building the devcontainer image ${tag} failed:\n${tailOf(output)}`));
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
