// CI guards (requirements §15): catches a PR getting green by lowering the bar. Runs from the base branch and
// reads the PR only as data (.github/workflows/guards.yml), so a PR can't switch off its own guard.
// Run with BASE_SHA, HEAD_SHA and LABELS (a JSON array) set.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FileChange = { status: "A" | "M" | "D" | "R"; path: string; oldPath?: string };
export type PrDiff = {
  files: FileChange[];
  /** Added lines, by file. */
  added: Record<string, string[]>;
  base: (path: string) => string | null;
  head: (path: string) => string | null;
  labels: ReadonlySet<string>;
  /** Every agent and plugin file on the PR's head. */
  agentFiles: string[];
};
export type Failure = { check: string; message: string; label?: string };

const WEAKENING: RegExp[] = [
  /\.(only|skip|todo|fixme)\(/,
  /\bskipIf\b/,
  /@ts-(ignore|nocheck|expect-error)/,
  /eslint-disable/,
  /\bas any\b/,
  /continue-on-error/,
  /\|\| true\b/,
  /--no-verify/,
  /\bretries:/,
  /(?<!expect|assert)\.fails?\(/,
  /\bexpect\(\s*(true|false|null|undefined|\d+|"[^"]*"|'[^']*')\s*\)/,
  /\bas unknown as\b/,
  /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
];
const DESTRUCTIVE_SQL =
  /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE|SET\s+NOT\s+NULL)\b/i;
export const AGENT_FILE = /^agents\/[^/]+\.md$|^plugins\//;
const CODE = /\.(ts|tsx|mjs|cjs|js|ya?ml)$/;
const SELF = /(^|\/)ci-guards(\.test)?\.ts$/;
const TEST = /\.(test|spec)\.tsx?$/;
const PROTECTED = [
  /^\.github\//,
  /(^|\/)eslint\.config\./,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)vitest\.config\./,
  /(^|\/)playwright\.config\./,
  /^\.prettier(ignore|rc)/,
  /^pnpm-workspace\.yaml$/,
  /^knip\.json$/,
  /^\.gitleaks\.toml$/,
  /^\.node-version$/,
  /test-network-guard\.ts$/,
  /^apps\/worker\/src\/runtime\/(fence|redact)\.ts$/,
  /^apps\/web\/(proxy|lib\/auth)\.ts$/,
  /(^|\/)global-setup\.ts$/,
  /(^|\/)repo-rules\.test\.ts$/,
  /^\.claude\//,
  /^Dockerfile$/,
  /^docker-compose\.yml$/,
  /^\.gitattributes$/,
  /^\.npmrc$/,
  SELF,
];
// The API routes that can't go through route(): auth redirects, SSE and the unauthenticated health check.
const NO_ROUTE_WRAPPER = new Set(
  [
    "auth/callback",
    "auth/login",
    "auth/logout",
    "events",
    "github/callback",
    "github/setup",
    "health",
  ].map((r) => `apps/web/app/api/${r}/route.ts`),
);

const count = (text: string | null, pattern: RegExp) => text?.match(pattern)?.length ?? 0;
const TEST_CASE =
  /(?<![.\w])(?:it|test)(?:\.(?:only|skip|each|runIf|skipIf|concurrent|fails)\b)*(?:\([^)]*\))?\s*\(/g;
const ASSERTION = /\bexpect(?:\.\w+)?\(/g;

/** Ties evals/baseline.json to the exact agents it was run on. Line endings don't count. */
export function agentsHash(files: [path: string, text: string][]) {
  const hash = createHash("sha256");
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1)))
    hash.update(`${path}\0${text.replace(/\r\n/g, "\n")}\0`);
  return hash.digest("hex");
}

function manifest(text: string | null) {
  const pkg = text ? (JSON.parse(text) as Record<string, Record<string, string> | undefined>) : {};
  return {
    scripts: pkg.scripts ?? {},
    installSettings: JSON.stringify([pkg.pnpm, pkg.packageManager, pkg.engines]),
    deps: new Set(
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) =>
        Object.keys(pkg[k] ?? {}),
      ),
    ),
  };
}

const sameScripts = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Every rule, on one PR. Failures whose override label is on the PR are dropped. */
export function evaluate(pr: PrDiff): Failure[] {
  const out: Failure[] = [];
  const changed = pr.files.filter((f) => f.status !== "D");
  const baseOf = (f: FileChange) => pr.base(f.oldPath ?? f.path);

  for (const [path, lines] of Object.entries(pr.added)) {
    if (!CODE.test(path) || SELF.test(path) || path.startsWith("fixtures/")) continue;
    for (const line of lines) {
      const hit = WEAKENING.find((p) => p.test(line));
      if (hit)
        out.push({
          check: "weakening",
          message: `${path}: adds "${line.trim().slice(0, 100)}"`,
          label: "allow-weakening",
        });
    }
  }

  const tests = pr.files.filter((f) => TEST.test(f.path) || TEST.test(f.oldPath ?? ""));
  for (const f of tests.filter((t) => t.status === "D"))
    out.push({
      check: "test-loss",
      message: `${f.path}: test file deleted`,
      label: "allow-test-removal",
    });
  for (const f of tests.filter((t) => t.status === "R" && !TEST.test(t.path)))
    out.push({
      check: "test-loss",
      message: `${f.oldPath}: renamed so it no longer runs`,
      label: "allow-test-removal",
    });
  for (const f of pr.files)
    if (f.status !== "A" && /^fixtures\/(runs|golden)\//.test(f.oldPath ?? f.path))
      out.push({
        check: "test-loss",
        message: `${f.path}: existing replay fixture changed`,
        label: "allow-test-removal",
      });
  for (const [what, pattern] of [
    ["test cases", TEST_CASE],
    ["assertions", ASSERTION],
  ] as const) {
    const delta = tests.reduce(
      (n, f) =>
        n +
        count(f.status !== "D" && TEST.test(f.path) ? pr.head(f.path) : null, pattern) -
        count(baseOf(f), pattern),
      0,
    );
    if (delta < 0)
      out.push({
        check: "test-loss",
        message: `${-delta} fewer ${what} than the base branch`,
        label: "allow-test-removal",
      });
  }

  for (const f of pr.files.filter((c) => PROTECTED.some((p) => p.test(c.path))))
    out.push({
      check: "protected",
      message: `${f.path}: protected file changed`,
      label: "ci-change",
    });

  for (const f of pr.files.filter((c) => /^packages\/shared\/drizzle\/[^/]+\.sql$/.test(c.path)))
    if (f.status !== "A")
      out.push({ check: "migrations", message: `${f.path}: migrations are append-only` });
  for (const [path, lines] of Object.entries(pr.added))
    if (/^packages\/shared\/drizzle\/[^/]+\.sql$/.test(path))
      for (const line of lines.filter((l) => DESTRUCTIVE_SQL.test(l)))
        out.push({
          check: "migrations",
          message: `${path}: can lose data on deploy: "${line.trim().slice(0, 100)}"`,
          label: "destructive-migration",
        });
  const journal = "packages/shared/drizzle/meta/_journal.json";
  if (pr.files.some((f) => f.path === journal)) {
    const entries = (t: string | null) =>
      t ? (JSON.parse(t) as { entries: unknown[] }).entries.map((e) => JSON.stringify(e)) : [];
    const [before, after] = [entries(pr.base(journal)), entries(pr.head(journal))];
    if (before.some((e, i) => e !== after[i]))
      out.push({ check: "migrations", message: `${journal}: existing entries changed` });
  }

  if (pr.files.some((f) => AGENT_FILE.test(f.path) || AGENT_FILE.test(f.oldPath ?? ""))) {
    const saved = JSON.parse(pr.head("evals/baseline.json") ?? "{}") as Record<string, unknown>;
    const hash = agentsHash(pr.agentFiles.map((p) => [p, pr.head(p) ?? ""]));
    if (saved.runtime !== "sdk" || saved.agentsHash !== hash)
      out.push({
        check: "agent-eval",
        message:
          "an agent or plugin changed: evals/baseline.json must come from `pnpm eval:agents --baseline` with real agents on these exact files (§8)",
        label: "eval-skip",
      });
  }

  for (const f of changed.filter((c) => /(^|\/)package\.json$/.test(c.path))) {
    if (f.path.startsWith("fixtures/")) continue;
    const before = manifest(baseOf(f));
    const after = manifest(pr.head(f.path));
    for (const dep of after.deps)
      if (!before.deps.has(dep))
        out.push({ check: "new-dep", message: `${f.path}: adds ${dep}`, label: "new-dep" });
    if (
      f.status !== "A" &&
      (!sameScripts(before.scripts, after.scripts) ||
        before.installSettings !== after.installSettings)
    )
      out.push({
        check: "protected",
        message: `${f.path}: scripts or install settings changed`,
        label: "ci-change",
      });
  }

  for (const f of changed) {
    const name = f.path.split("/").pop()!;
    if (/\.py$/i.test(name)) out.push({ check: "repo-rules", message: `${f.path}: no Python` });
    if (/^\.env(\..+)?$/.test(name) && name !== ".env.example")
      out.push({ check: "repo-rules", message: `${f.path}: never commit env files` });
    if (!/^(apps|packages)\/.*\.tsx?$/.test(f.path) || SELF.test(f.path)) continue;
    const text = pr.head(f.path) ?? "";
    if (!TEST.test(f.path) && !f.path.includes("/test/") && /\.localeCompare\(/.test(text))
      out.push({
        check: "repo-rules",
        message: `${f.path}: localeCompare breaks fractional-index order`,
      });
    const other = f.path.startsWith("apps/web/")
      ? /from\s+["'][^"']*(apps\/worker|@kanbot\/worker|\.\.\/worker\/)/
      : f.path.startsWith("apps/worker/")
        ? /from\s+["'][^"']*(apps\/web|@kanbot\/web|\.\.\/web\/)/
        : null;
    if (other?.test(text))
      out.push({
        check: "repo-rules",
        message: `${f.path}: web and worker never import each other`,
      });
    if (
      /^apps\/web\/app\/api\/.*\/route\.ts$/.test(f.path) &&
      !NO_ROUTE_WRAPPER.has(f.path) &&
      !/\broute\(/.test(text)
    )
      out.push({ check: "repo-rules", message: `${f.path}: API handlers go through route()` });
  }

  return out.filter((f) => !f.label || !pr.labels.has(f.label));
}

/** `git diff -U0` output to added lines by file. */
export function addedLines(diff: string): Record<string, string[]> {
  const added: Record<string, string[]> = {};
  let file: string | null = null;
  let header = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      file = null;
    } else if (header && line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : null;
      if (file) added[file] = [];
    } else if (line.startsWith("@@")) header = false;
    else if (!header && file && line.startsWith("+")) added[file]!.push(line.slice(1));
  }
  return added;
}

export function parseNameStatus(text: string): FileChange[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split("\t") as [string, string, string?];
      if (status.startsWith("R")) return { status: "R", path: b!, oldPath: a };
      // A copy is a new file as far as these rules go; T (type change) is a modification.
      return {
        status: status[0] === "D" ? "D" : status[0] === "A" || status[0] === "C" ? "A" : "M",
        path: b ?? a,
      };
    });
}

function main() {
  const { BASE_SHA, HEAD_SHA, LABELS } = process.env;
  if (!BASE_SHA || !HEAD_SHA) throw new Error("BASE_SHA and HEAD_SHA are required");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.quotepath=off", ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"], // a path missing from one side is expected
    });
  const show = (sha: string) => (path: string) => {
    try {
      return git("show", `${sha}:${path}`);
    } catch {
      return null;
    }
  };
  const mergeBase = git("merge-base", BASE_SHA, HEAD_SHA).trim();
  const files = parseNameStatus(git("diff", "--name-status", "-M", mergeBase, HEAD_SHA));
  const failures = evaluate({
    files,
    added: addedLines(git("diff", "-U0", "--no-color", "-M", mergeBase, HEAD_SHA)),
    base: show(mergeBase),
    head: show(HEAD_SHA),
    labels: new Set(JSON.parse(LABELS ?? "[]") as string[]),
    agentFiles: git("ls-tree", "-r", "--name-only", HEAD_SHA)
      .split("\n")
      .filter((p) => AGENT_FILE.test(p)),
  });

  if (files.some((f) => f.path === "pnpm-lock.yaml")) {
    // Audits the PR's lockfile in a scratch folder: its manifests are data, so packageManager is dropped.
    const dir = mkdtempSync(join(tmpdir(), "kanbot-audit-"));
    const manifests = git("ls-tree", "-r", "--name-only", HEAD_SHA)
      .split("\n")
      .filter((p) => /^(package\.json|(apps|packages)\/[^/]+\/package\.json)$/.test(p));
    for (const path of manifests) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      const { packageManager: _drop, ...pkg } = JSON.parse(show(HEAD_SHA)(path)!) as Record<
        string,
        unknown
      >;
      writeFileSync(join(dir, path), JSON.stringify(pkg));
    }
    writeFileSync(join(dir, "pnpm-lock.yaml"), show(HEAD_SHA)("pnpm-lock.yaml")!);
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
    try {
      execFileSync("pnpm", ["audit", "--prod", "--audit-level=high"], {
        cwd: dir,
        stdio: "inherit",
      });
    } catch (e) {
      const ran = (e as { status?: number | null }).status != null;
      failures.push({
        check: "audit",
        message: ran
          ? "pnpm audit failed: see its output above"
          : `pnpm audit didn't start: ${String(e)}`,
      });
    }
  }

  for (const f of failures) {
    const fix = f.label ? ` (a human can override with the "${f.label}" label)` : "";
    console.log(`::error title=${f.check}::${f.message}${fix}`);
  }
  console.log(failures.length ? `${failures.length} guard failure(s)` : "All guards pass");
  process.exitCode = failures.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
