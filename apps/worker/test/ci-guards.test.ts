import { describe, expect, it } from "vitest";
import {
  addedLines,
  evaluate,
  parseNameStatus,
  type FileChange,
  type PrDiff,
} from "../src/ci-guards";

function pr(
  files: FileChange[],
  o: {
    added?: PrDiff["added"];
    base?: Record<string, string>;
    head?: Record<string, string>;
    labels?: string[];
  } = {},
): PrDiff {
  return {
    files,
    added: o.added ?? {},
    base: (p) => o.base?.[p] ?? null,
    head: (p) => o.head?.[p] ?? null,
    labels: new Set(o.labels),
  };
}
const M = (path: string): FileChange => ({ status: "M", path });
const checks = (d: PrDiff) => evaluate(d).map((f) => f.check);

describe("weakening", () => {
  const add = (line: string, path = "apps/worker/src/a.ts") =>
    checks(pr([M(path)], { added: { [path]: [line] } }));

  it.each([
    'it.only("x", f)',
    'test.skip("x", f)',
    "describe.skipIf(!x)",
    "// @ts-ignore",
    "// @ts-expect-error",
    "// eslint-disable-next-line",
    "const a = b as any;",
    "  retries: 2,",
  ])("flags %s", (line) => expect(add(line)).toEqual(["weakening"]));

  it("flags a shell bypass in a workflow", () => {
    expect(add("run: pnpm test || true", ".github/x.yml")).toContain("weakening");
  });

  it.each(["const apiRetries: 2", "expect(a).toBe(1)", "skip the thing"])("allows %s", (line) =>
    expect(add(line)).toEqual([]),
  );

  it("ignores docs, fixtures and its own patterns", () => {
    expect(add("it.only(", "docs/a.md")).toEqual([]);
    expect(add("it.only(", "fixtures/sample-repo/a.js")).toEqual([]);
    expect(add("it.only(", "apps/worker/src/ci-guards.ts")).not.toContain("weakening");
  });

  it("lets the label through", () => {
    const d = pr([M("a.ts")], { added: { "a.ts": ["x as any"] }, labels: ["allow-weakening"] });
    expect(evaluate(d)).toEqual([]);
  });
});

describe("test loss", () => {
  const path = "apps/worker/test/a.test.ts";
  const two = 'it("a", () => { expect(1).toBe(1); });\ntest("b", () => { expect(2).toBe(2); });';
  const one = 'it("a", () => { expect(1).toBe(1); });';

  it("flags a deleted test file", () => {
    const d = pr([{ status: "D", path }], { base: { [path]: two } });
    expect(evaluate(d).map((f) => f.message)).toContain(`${path}: test file deleted`);
  });

  it("flags fewer tests and fewer assertions", () => {
    const failures = evaluate(pr([M(path)], { base: { [path]: two }, head: { [path]: one } }));
    expect(failures.map((f) => f.message)).toEqual([
      "1 fewer test cases than the base branch",
      "1 fewer assertions than the base branch",
    ]);
  });

  it("flags a test emptied of its assertions", () => {
    const hollow = 'it("a", () => {});\ntest("b", () => {});';
    const d = pr([M(path)], { base: { [path]: two }, head: { [path]: hollow } });
    expect(evaluate(d).map((f) => f.message)).toEqual(["2 fewer assertions than the base branch"]);
  });

  it("counts a test moved between files as no loss", () => {
    const other = "apps/worker/test/b.test.ts";
    const moved = 'test("b", () => { expect(2).toBe(2); });';
    const d = pr([M(path), { status: "A", path: other }], {
      base: { [path]: two },
      head: { [path]: one, [other]: moved },
    });
    expect(evaluate(d)).toEqual([]);
  });

  it("follows a rename", () => {
    const to = "apps/worker/test/c.test.ts";
    const d = pr([{ status: "R", path: to, oldPath: path }], {
      base: { [path]: two },
      head: { [to]: two },
    });
    expect(evaluate(d)).toEqual([]);
  });

  it("does not count test.describe or test.use as tests", () => {
    const setup = 'test.use({});\ntest.describe("x", () => {});';
    const d = pr([M("a.spec.ts")], { base: { "a.spec.ts": setup }, head: { "a.spec.ts": "" } });
    expect(evaluate(d)).toEqual([]);
  });
});

describe("protected files", () => {
  it.each([
    ".github/workflows/ci.yml",
    "eslint.config.mjs",
    "apps/web/eslint.config.mjs",
    "tsconfig.base.json",
    "apps/worker/vitest.config.ts",
    "apps/web/playwright.config.ts",
    "apps/worker/src/ci-guards.ts",
    "packages/shared/src/test-network-guard.ts",
  ])("%s needs the label", (path) => {
    expect(checks(pr([M(path)]))).toEqual(["protected"]);
    expect(evaluate(pr([M(path)], { labels: ["ci-change"] }))).toEqual([]);
  });

  it("flags changed package scripts", () => {
    const d = pr([M("package.json")], {
      base: { "package.json": '{"scripts":{"test":"vitest run"}}' },
      head: { "package.json": '{"scripts":{"test":"exit 0"}}' },
    });
    expect(checks(d)).toEqual(["protected"]);
  });
});

describe("migrations", () => {
  const sql = "packages/shared/drizzle/0001_x.sql";
  const journal = "packages/shared/drizzle/meta/_journal.json";

  it("allows a new one", () => {
    expect(evaluate(pr([{ status: "A", path: sql }]))).toEqual([]);
  });

  it("refuses an edit or a delete, even with a label", () => {
    expect(checks(pr([M(sql)], { labels: ["ci-change", "allow-weakening"] }))).toEqual([
      "migrations",
    ]);
    expect(checks(pr([{ status: "D", path: sql }]))).toEqual(["migrations"]);
  });

  it("allows appending to the journal but not rewriting it", () => {
    const j = (...tags: string[]) => JSON.stringify({ entries: tags.map((tag) => ({ tag })) });
    const base = { [journal]: j("a", "b") };
    expect(evaluate(pr([M(journal)], { base, head: { [journal]: j("a", "b", "c") } }))).toEqual([]);
    expect(checks(pr([M(journal)], { base, head: { [journal]: j("a", "x") } }))).toEqual([
      "migrations",
    ]);
  });
});

describe("agent eval", () => {
  it("needs a new baseline when a prompt changes", () => {
    expect(checks(pr([M("agents/plan-b.md")]))).toEqual(["agent-eval"]);
    expect(evaluate(pr([M("agents/plan-b.md"), M("evals/baseline.json")]))).toEqual([]);
    expect(evaluate(pr([M("agents/plan-b.md")], { labels: ["eval-skip"] }))).toEqual([]);
  });

  it("counts plugins but not avatars", () => {
    expect(checks(pr([M("plugins/ponytail/SKILL.md")]))).toEqual(["agent-eval"]);
    expect(evaluate(pr([M("agents/avatars/plan-b.svg")]))).toEqual([]);
  });
});

describe("new dependencies", () => {
  const p = "apps/web/package.json";
  it("flags an added name, not a version bump", () => {
    const base = { [p]: '{"dependencies":{"zod":"1.0.0"}}' };
    const bump = pr([M(p)], { base, head: { [p]: '{"dependencies":{"zod":"2.0.0"}}' } });
    expect(evaluate(bump)).toEqual([]);
    const added = pr([M(p)], {
      base,
      head: { [p]: '{"dependencies":{"zod":"1.0.0"},"devDependencies":{"left-padd":"1.0.0"}}' },
    });
    expect(evaluate(added)).toEqual([
      { check: "new-dep", message: `${p}: adds left-padd`, label: "new-dep" },
    ]);
  });
});

describe("repo rules", () => {
  const head = (path: string, text: string, status: FileChange["status"] = "A") =>
    checks(pr([{ status, path }], { head: { [path]: text } }));

  it("refuses Python and env files", () => {
    expect(head("scripts/a.py", "")).toEqual(["repo-rules"]);
    expect(head("apps/web/.env", "")).toEqual(["repo-rules"]);
    expect(head(".env.local", "")).toEqual(["repo-rules"]);
    expect(head(".env.example", "")).toEqual([]);
  });

  it("refuses localeCompare outside tests", () => {
    expect(head("apps/web/lib/a.ts", "a.localeCompare(b)")).toEqual(["repo-rules"]);
    expect(head("apps/worker/test/a.ts", "a.localeCompare(b)")).toEqual([]);
  });

  it("keeps web and worker apart", () => {
    expect(head("apps/web/lib/a.ts", 'import x from "../../worker/src/a";')).toEqual([
      "repo-rules",
    ]);
    expect(head("apps/worker/src/a.ts", 'import x from "@kanbot/web/a";')).toEqual(["repo-rules"]);
    expect(head("apps/worker/src/a.ts", 'import x from "@kanbot/shared";')).toEqual([]);
  });

  it("needs route() on API handlers, bar the listed ones", () => {
    const path = "apps/web/app/api/things/route.ts";
    expect(head(path, "export function GET() {}")).toEqual(["repo-rules"]);
    expect(head(path, "export const GET = route(async () => {});")).toEqual([]);
    expect(head("apps/web/app/api/health/route.ts", "export function GET() {}", "M")).toEqual([]);
  });
});

describe("git parsing", () => {
  it("reads name-status lines", () => {
    expect(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\nR095\td.ts\te.ts\n")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "A", path: "b.ts" },
      { status: "D", path: "c.ts" },
      { status: "R", path: "e.ts", oldPath: "d.ts" },
    ]);
  });

  it("reads added lines by file, including ones that look like headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+++ b/not-a-file",
      "-gone",
      "diff --git a/c.ts b/c.ts",
      "--- a/c.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ].join("\n");
    expect(addedLines(diff)).toEqual({ "a.ts": ["one", "++ b/not-a-file"] });
  });
});
