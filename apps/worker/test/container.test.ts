import { describe, expect, it } from "vitest";
import { containerBash, dockerRun, projectImage, shQuote } from "../src/worktree";

const cwd = process.platform === "win32" ? "C:\\r\\wt" : "/r/wt";
const mounted = process.platform === "win32" ? "/c/r/wt" : "/r/wt";

describe("project commands in containers (§7)", () => {
  it("mounts only the worktree and the cache, passes no host env, publishes on 127.0.0.1", () => {
    const args = dockerRun("node:24", cwd, "node --test", { name: "n", port: 4100 });
    expect(args.join(" ")).toBe(
      `run --rm --init --label kanbot --name n -v ${cwd}:${mounted} -w ${mounted} ` +
        "-v kanbot-cache:/cache -e HOME=/cache -e PORT=4100 -p 127.0.0.1:4100:4100 " +
        "node:24 sh -c node --test",
    );
  });

  it("moves the project's own commands into the image and leaves the rest on the host", () => {
    const bash = containerBash("node:24", cwd, { test: "node --test", lint: "eslint ." }, "run-1");
    const cmd = bash("node --test  test/a.test.ts")!;
    expect(cmd).toMatch(/^(MSYS_NO_PATHCONV=1 )?'docker' 'run' /);
    expect(cmd).toContain("'kanbot=run-1'");
    expect(cmd.endsWith("'node:24' 'sh' '-c' 'node --test test/a.test.ts'")).toBe(true);
    expect(bash("eslint .")).not.toBeNull();
    expect(bash("git status")).toBeNull();
    expect(bash("node --testx")).toBeNull(); // a prefix of a word isn't the command
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
