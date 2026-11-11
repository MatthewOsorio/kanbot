// Running a project's own commands: install, the checks gate, the baseline, and agents' commits.
import { exec, execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Baseline, uuidv7 } from "@kanbot/shared";
import { type ProjectConfig } from "@kanbot/shared/server";
import { dockerRun, pullImage, removeContainers, shQuote, tailOf } from "./docker";

const execFileP = promisify(execFile);
const sh = promisify(exec);

/**
 * The project's env vars (§10) for its commands: `vars` for the worker's toolchain, `file` (docker's
 * --env-file) for containers, so values never appear in a command line. Empty values (names not set yet)
 * are left out.
 */
export type ProjectEnv = { vars: Record<string, string>; file?: string };
export const NO_ENV: ProjectEnv = { vars: {} };

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

/** Runs one project command; null if it passed, else the tail of its output. */
async function tryCommand(command: string, path: string, image?: string, env = NO_ENV) {
  try {
    await runCommand(command, path, image, env);
    return null;
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string; killed?: boolean };
    const text = [err.stdout, err.stderr].filter(Boolean).join("\n").trimEnd();
    return (err.killed ? "Killed after 10 minutes.\n" : "") + (text ? tailOf(text) : err.message);
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
export const commandEnv = () => withoutSecrets(["ANTHROPIC_API_KEY"]);

/** Kanbot's own credentials: the database, and the keys that sign the owner's session and decrypt the App. */
const SECRETS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "POSTGRES_PASSWORD",
  "KANBOT_SESSION_SECRET",
  "KANBOT_ENCRYPTION_KEY",
];

/** The worker's environment without Kanbot's credentials (and `also`), for anything agents or projects run. */
export function withoutSecrets(also: string[] = []) {
  const drop = new Set([...SECRETS, ...also]);
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k)));
}

/**
 * A project command, run by the worker itself (install, the checks gate): in the project's image when it
 * has one (§7), else on the worker's toolchain with the same scrubbed env agents get.
 */
export async function runCommand(command: string, cwd: string, image?: string, env = NO_ENV) {
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
