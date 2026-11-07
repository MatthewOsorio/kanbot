import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  baselineFailures,
  detect,
  envNames,
  missingRules,
  qaRunnable,
  starterWorkflow,
} from "./onboarding";

const read = (files: Record<string, string>) => (f: string) => files[f] ?? "";

describe("detect", () => {
  it("reads a pnpm project's scripts", () => {
    const pkg = JSON.stringify({ scripts: { build: "tsc", test: "vitest", dev: "x" } });
    const d = detect(["package.json", "pnpm-lock.yaml", "src/a.ts"], read({ "package.json": pkg }));
    expect(d.commands).toEqual({
      install: "pnpm install --frozen-lockfile",
      build: "pnpm run build",
      lint: undefined,
      test: "pnpm run test",
      start: undefined,
    });
    expect(d.image).toBe("node:24-bookworm");
  });

  it("uses npm ci only with a package-lock", () => {
    expect(detect(["package.json", "package-lock.json"], read({})).commands.install).toBe("npm ci");
    expect(detect(["package.json"], read({ "package.json": "not json" })).commands.install).toBe(
      "npm install",
    );
  });

  it("reads a Python project (pytest when it's a dependency)", () => {
    const d = detect(
      ["requirements.txt", "app/main.py", "tests/test_main.py"],
      read({ "requirements.txt": "flask\npytest==8\n" }),
    );
    expect(d.commands).toEqual({
      install: "pip install --user -r requirements.txt",
      build: "python -m compileall -q .",
      test: "python -m pytest",
    });
    expect(d.image).toBe("python:3.12-bookworm");
  });

  it("gives a Python repo with no deps or tests just a compile check (NetGPT's shape)", () => {
    const d = detect(["main.py", "src/packet.py", "readme.md"], read({}));
    expect(d.commands).toEqual({
      install: undefined,
      build: "python -m compileall -q .",
      test: undefined,
    });
  });

  it("reads a Go module", () => {
    expect(detect(["go.mod", "main.go"], read({})).commands.test).toBe("go test ./...");
  });

  it("finds nothing in an unknown repo", () => {
    expect(detect(["README.md"], read({}))).toEqual({ commands: {}, testGlobs: [] });
  });
});

describe("starterWorkflow", () => {
  it("runs the commands in the image, on kanbot branches and PRs", () => {
    const y = parse(
      starterWorkflow({ install: "npm ci", test: "npm test", start: "x" }, "node:24"),
    );
    expect(y.on).toEqual({ push: { branches: ["kanbot/**"] }, pull_request: null });
    expect(y.jobs.ci.container).toBe("node:24");
    expect(y.jobs.ci.steps).toEqual([
      { uses: "actions/checkout@v4" },
      { name: "install", run: "npm ci" },
      { name: "test", run: "npm test" },
    ]);
  });

  it("leaves out the container without an image", () => {
    expect(parse(starterWorkflow({}, undefined)).jobs.ci.container).toBeUndefined();
  });

  it("reads the env vars from the repo's Actions secrets", () => {
    const y = parse(starterWorkflow({}, undefined, ["API_KEY", "DATABASE_URL"]));
    expect(y.jobs.ci.env).toEqual({
      API_KEY: "${{ secrets.API_KEY }}",
      DATABASE_URL: "${{ secrets.DATABASE_URL }}",
    });
    expect(parse(starterWorkflow({}, undefined)).jobs.ci.env).toBeUndefined();
  });
});

describe("envNames", () => {
  it("lists the names in a dotenv file, once each", () => {
    const text = [
      "# comment = not a var",
      "",
      "API_KEY=",
      "export DATABASE_URL=postgres://localhost/x",
      "  SPACED = 1",
      "API_KEY=again",
      "not a line",
      "1BAD=x",
    ].join("\r\n");
    expect(envNames(text)).toEqual(["API_KEY", "DATABASE_URL", "SPACED"]);
  });
});

describe("missingRules", () => {
  it("lists every rule for an unprotected branch", () => {
    expect(missingRules(null)).toHaveLength(4);
  });

  it("is empty when §10's rules are all there", () => {
    expect(
      missingRules({
        required_status_checks: { strict: true },
        required_pull_request_reviews: { required_approving_review_count: 1 },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      }),
    ).toEqual([]);
  });

  it("flags loose checks, no reviews and force-pushes", () => {
    expect(
      missingRules({
        required_status_checks: { strict: false },
        required_pull_request_reviews: { required_approving_review_count: 0 },
        allow_force_pushes: { enabled: true },
        allow_deletions: { enabled: false },
      }),
    ).toEqual([
      "a pull request with 1 approving review",
      "status checks passing on an up-to-date branch",
      "no force-pushes",
    ]);
  });
});

it("baselineFailures lists the failed commands", () => {
  expect(
    baselineFailures({
      build: { command: "b", ok: true, output: "" },
      test: { command: "t", ok: false, output: "1 failed" },
    }),
  ).toEqual(["t"]);
  expect(baselineFailures(null)).toEqual([]);
});

describe("qaRunnable", () => {
  it("needs a start command", () => {
    expect(qaRunnable({ commands: { build: "x", test: "t" } })).toBe(false);
    expect(qaRunnable({ commands: { start: " " } })).toBe(false);
    expect(qaRunnable({ commands: { start: "s" } })).toBe(true);
  });
});
