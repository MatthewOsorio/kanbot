// The app under test: started for a QA run on a free port, in the project's image when it has one (§4).
import { execFile, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { promisify } from "node:util";
import { uuidv7 } from "@kanbot/shared";
import { commandEnv, NO_ENV } from "./commands";
import { dockerRun, LABEL, pullImage, removeContainers, tailOf } from "./docker";

const execFileP = promisify(execFile);

/** The sidecar that owns a QA app's network and forwards to whatever port the app listens on (§4). */
const FORWARDER_IMAGE = "alpine/socat:1.8.0.3";
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
  const tail = () => tailOf(output);
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
