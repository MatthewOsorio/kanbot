// The permission fence (requirements §14): pure, no database or SDK.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandTools } from "../src/run";
import { checkToolCall } from "../src/runtime/fence";

const root = mkdtempSync(join(tmpdir(), "kanbot-fence-"));
const cwd = join(root, "repo");
mkdirSync(join(cwd, "src"), { recursive: true });
writeFileSync(join(cwd, "src", "a.ts"), "");
writeFileSync(join(root, "secret.txt"), "");
let linked = true;
try {
  symlinkSync(root, join(cwd, "out"), "junction");
} catch {
  linked = false; // no symlink rights on this machine
}

const readOnly = { cwd, tools: ["Read", "Grep", "Glob"] };
const deny = (name: string, input: Record<string, unknown>, f = readOnly) =>
  checkToolCall(name, input, f);

describe("cwd fence for Read, Grep, Glob", () => {
  it("allows paths inside the working directory", () => {
    expect(deny("Read", { file_path: "src/a.ts" })).toBeNull();
    expect(deny("Read", { file_path: join(cwd, "src", "a.ts") })).toBeNull();
    expect(deny("Grep", { pattern: "foo" })).toBeNull(); // no path = cwd
    // Grep's pattern is a regex: a leading backslash is not a path (refused in the M3 smoke run).
    expect(deny("Grep", { pattern: String.raw`\.remove\(` })).toBeNull();
    expect(deny("Glob", { pattern: "src/**/*.ts" })).toBeNull();
  });

  it("refuses paths that resolve outside it", () => {
    expect(deny("Read", { file_path: "../secret.txt" })).toMatch(/outside/);
    expect(deny("Read", { file_path: join(root, "secret.txt") })).toMatch(/outside/);
    expect(deny("Grep", { pattern: "x", path: ".." })).toMatch(/outside/);
    expect(deny("Glob", { pattern: "*", path: root })).toMatch(/outside/);
  });

  // On Linux these are ordinary relative file names inside cwd, so the fence rightly allows them.
  it.runIf(process.platform === "win32")("refuses Windows drive and device paths", () => {
    expect(deny("Read", { file_path: "C:\\Windows\\win.ini" })).toMatch(/outside/);
    expect(deny("Read", { file_path: "\\\\?\\C:\\Windows\\win.ini" })).toMatch(/outside/);
  });

  it("refuses globs that climb out", () => {
    expect(deny("Glob", { pattern: "../**/*" })).toMatch(/outside/);
    expect(deny("Glob", { pattern: "/etc/*" })).toMatch(/outside/);
    expect(deny("Grep", { pattern: "x", glob: "../*.txt" })).toMatch(/outside/);
  });

  it.runIf(linked)("refuses a symlink inside cwd that points out", () => {
    expect(deny("Read", { file_path: "out/secret.txt" })).toMatch(/outside/);
  });

  it("refuses tools not in the list", () => {
    expect(deny("Bash", { command: "ls" })).toMatch(/not in this agent's tools/);
    expect(deny("Edit", { file_path: "src/a.ts" })).toMatch(/not in this agent's tools/);
  });
});

describe("Bash allowlist and edit scope", () => {
  const coder = {
    cwd,
    tools: [
      "Read",
      "Edit",
      "Write",
      "Bash(git diff:*)",
      "Bash(git status)",
      "Bash(node --test)",
      "Bash(git commit:*)",
    ],
    canEdit: (rel: string) => rel.startsWith("src/"),
  };
  const bash = (command: string) => checkToolCall("Bash", { command }, coder);

  it("allows exact and prefix matches", () => {
    expect(bash("git status")).toBeNull();
    expect(bash("git diff --stat main...HEAD")).toBeNull();
    expect(bash("node --test")).toBeNull();
  });

  it("refuses other commands, chaining and escapes", () => {
    expect(bash("git status --porcelain")).toMatch(/allowlist/); // exact rule
    expect(bash("cat /etc/passwd")).toMatch(/outside/);
    expect(bash("ls")).toMatch(/allowlist/);
    expect(bash("git status && rm -rf src")).toMatch(/plain command/);
    expect(bash("git diff $(whoami)")).toMatch(/plain command/);
    expect(bash("git diff > out.txt")).toMatch(/plain command/);
    expect(bash("git diff --output=x")).toMatch(/outside/);
    expect(bash("git diff --no-index a b")).toMatch(/outside/);
    expect(bash("git diff ../other")).toMatch(/outside/);
    expect(bash("git diffx")).toMatch(/allowlist/);
  });

  // Escape attempts an agent could plausibly try; each must be refused (M3 hardening pass).
  it.each([
    'git diff "../secret.txt"',
    "git diff '../secret.txt'",
    "git diff ..\\secret.txt",
    "git diff C:/Windows/win.ini",
    "git diff //host/share/x",
    "git diff ~/x",
    "git diff $HOME",
    "git diff\nrm -rf src",
    "git diff;rm -rf src",
    "git diff | tee x",
    "git diff `id`",
    "git diff --output ../x",
    "git diff -- ../x",
    "git diff --git-dir=../x",
    "git -C .. diff",
    "git diff {..,src}/x",
    "git diff ..",
    'git diff "--output=../x"',
    'git diff "$(id)"',
    "git diff 'unterminated",
    "git diff (x)",
    'git commit -m "msg" -F ../msg.txt',
    'git commit -m "a\nb"',
    'git diff -m "/etc/passwd"', // the message exemption is for git commit only
  ])("refuses %j", (command) => {
    expect(bash(command)).not.toBeNull();
  });

  it.each([
    ["Read", { file_path: "src/../../secret.txt" }],
    ["Read", { file_path: "~/secret.txt" }],
    ["Glob", { pattern: "{..,src}/*" }],
    ["Glob", { pattern: "{/etc,src}/*" }],
    ["Glob", { pattern: "{~,src}/*" }],
    ["Glob", { pattern: "src/**/../../*" }],
    ["Grep", { pattern: "x", glob: "{../*,*}" }],
    ["Grep", { pattern: "x", path: "src/../.." }],
  ] as const)("refuses %s %j", (name, input) => {
    expect(deny(name, input)).not.toBeNull();
  });

  it("still allows ordinary in-repo use", () => {
    expect(bash("git diff main...HEAD -- src/a.ts")).toBeNull();
    expect(bash("git diff HEAD~1")).toBeNull();
    // Both refused in the M3 golden run: message text isn't a path, and `<` inside quotes is literal.
    expect(
      bash(
        'git commit -m "Rename a todo via PATCH /api/todos/:id with a title body" -m "Reads only title from the body (no Object.assign, so id/done cannot be overwritten)." -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
      ),
    ).toBeNull();
    expect(bash("git commit -m 'fix(api): guard ../ paths; keep $HOME'")).toBeNull();
    expect(deny("Glob", { pattern: "{src,test}/**/*.ts" })).toBeNull();
    expect(deny("Read", { file_path: "src/../src/a.ts" })).toBeNull();
  });

  it("limits Edit and Write to the agent's scope", () => {
    expect(checkToolCall("Edit", { file_path: "src/a.ts" }, coder)).toBeNull();
    expect(checkToolCall("Write", { file_path: "src/new/b.ts" }, coder)).toBeNull();
    expect(checkToolCall("Write", { file_path: "README.md" }, coder)).toMatch(/may edit/);
    expect(checkToolCall("Write", { file_path: "../x.ts" }, coder)).toMatch(/outside/);
  });

  // A worktree's .git file says which repository it is; rewritten, commits land on main.
  it("never lets an agent edit .git, even with the whole worktree in scope", () => {
    const anywhere = { cwd, tools: ["Read", "Edit", "Write"] };
    for (const file_path of [".git", "./.git", ".GIT", ".git/config", join(cwd, ".git")])
      expect(checkToolCall("Write", { file_path }, anywhere)).toMatch(/git's own data/);
    expect(checkToolCall("Read", { file_path: ".git" }, anywhere)).toBeNull();
    expect(checkToolCall("Write", { file_path: ".gitignore" }, anywhere)).toBeNull();
  });
});

describe("expandTools", () => {
  it("fills {placeholders} from the project's commands and drops ones it lacks", () => {
    const tools = ["Read", "Bash({test}:*)", "Bash({lint}:*)", "Bash({install})"];
    expect(expandTools(tools, { test: "node --test", install: "pnpm install" })).toEqual([
      "Read",
      "Bash(node --test:*)",
      "Bash(pnpm install)",
    ]);
  });
});
