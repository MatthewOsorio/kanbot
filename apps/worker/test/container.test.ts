import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactText } from "../src/runtime/replay";
import { appPort, listeningPorts } from "../src/qa-app";
import { containerBash, dockerRun, projectImage, shQuote } from "../src/docker";
import { openEnv } from "../src/commands";

const cwd = process.platform === "win32" ? "C:\\r\\wt" : "/r/wt";
const mounted = process.platform === "win32" ? "/c/r/wt" : "/r/wt";

describe("project commands in containers (§7)", () => {
  it("mounts only the worktree and the cache, passes no host env, joins the forwarder's network", () => {
    const args = dockerRun("node:24", cwd, "node --test", { name: "n", port: 4100, network: "f" });
    expect(args.join(" ")).toBe(
      `run --rm --init --label kanbot --name n -v ${cwd}:${mounted} -w ${mounted} ` +
        "-v kanbot-cache:/cache -e HOME=/cache --network container:f -e PORT=4100 " +
        "node:24 sh -c node --test",
    );
  });

  it("finds the ports listening in a namespace, preferring the one QA gave", () => {
    const proc = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1",
      "   1: 00000000:9C3F 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2",
      "   2: 0100007F:1435 0100007F:D0F2 01 00000000:00000000 00:00000000 00000000  1000        0 3",
      "   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 0 0 0 0 0 4",
    ].join("\n");
    expect(listeningPorts(proc)).toEqual([5173, 8000, 39999]); // 5173 localhost-only, 8000 on IPv6
    expect(appPort([5173, 8000, 39999], 8000)).toBe(8000);
    expect(appPort([5173, 39999], 4100)).toBe(5173);
    expect(appPort([39999], 4100)).toBeUndefined(); // only the forwarder itself
  });

  it("moves the project's own commands into the image and leaves the rest on the host", () => {
    const bash = containerBash("node:24", cwd, { test: "node --test", lint: "eslint ." }, "run-1");
    const cmd = bash("node --test  test/a.test.ts")!;
    expect(cmd).toMatch(/^'docker' 'run' /);
    expect(cmd).toContain("'kanbot=run-1'");
    expect(cmd.endsWith("'node:24' 'sh' '-c' 'node --test test/a.test.ts'")).toBe(true);
    expect(bash("eslint .")).not.toBeNull();
    expect(bash("git status")).toBeNull();
    expect(bash("node --testx")).toBeNull(); // a prefix of a word isn't the command
  });

  it("passes the project's env vars as a file, never their values in argv (§10)", () => {
    const args = dockerRun("node:24", cwd, "node --test", { envFile: "/tmp/kanbot-env-x/env" });
    expect(args.join(" ")).toContain("-e HOME=/cache --env-file /tmp/kanbot-env-x/env node:24");
    const bash = containerBash("node:24", cwd, { test: "node --test" }, "run-1", "/tmp/e/env");
    expect(bash("node --test")).toContain("'--env-file' '/tmp/e/env'");
  });

  it("writes the env file 0600 outside the worktree, without unset names, and removes it", async () => {
    const env = await openEnv({ API_KEY: "s3cret-value", UNSET: "" });
    expect(env.vars).toEqual({ API_KEY: "s3cret-value" });
    expect(readFileSync(env.file!, "utf8")).toBe("API_KEY=s3cret-value\n");
    if (process.platform !== "win32") expect(statSync(env.file!).mode & 0o777).toBe(0o600);
    await env.dispose();
    expect(existsSync(env.file!)).toBe(false);
    expect((await openEnv({ UNSET: "" })).file).toBeUndefined();
  });

  it("redacts the project's env values from stored text, raw and JSON-escaped", () => {
    expect(redactText('{"out":"key=s3cret-value"}', ["s3cret-value", "short"])).toBe(
      '{"out":"key=[redacted]"}',
    );
    expect(redactText(JSON.stringify({ v: 'a"quoted"value' }), ['a"quoted"value'])).toBe(
      '{"v":"[redacted]"}',
    );
    expect(redactText("short stays", ["short"])).toBe("short stays");
  });

  it("redacts an API key that was set after the module loaded (.env is read after imports)", () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-loaded-late-from-dotenv";
    try {
      expect(redactText("got sk-loaded-late-from-dotenv here")).toBe("got [redacted] here");
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("quotes for a POSIX shell", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("falls back to KANBOT_DEFAULT_IMAGE when the project has none, and checks it", async () => {
    const before = process.env.KANBOT_DEFAULT_IMAGE;
    try {
      process.env.KANBOT_DEFAULT_IMAGE = "node:24-bookworm";
      expect(await projectImage("/r", "main", {}, "K")).toBe("node:24-bookworm");
      expect(await projectImage("/r", "main", { image: "go:1" }, "K")).toBe("go:1");
      process.env.KANBOT_DEFAULT_IMAGE = "--privileged";
      await expect(projectImage("/r", "main", {}, "K")).rejects.toThrow(/not an image reference/);
      delete process.env.KANBOT_DEFAULT_IMAGE;
      expect(await projectImage("/r", "main", {}, "K")).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.KANBOT_DEFAULT_IMAGE;
      else process.env.KANBOT_DEFAULT_IMAGE = before;
    }
  });
});
