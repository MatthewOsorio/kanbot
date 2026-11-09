// Conventions checked across the whole tree, unlike the guards, which only read what a PR changed.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const claudeMd = read("CLAUDE.md");

const sources = ["apps", "packages"]
  .flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
      .map((e) =>
        join(e.parentPath, e.name)
          .slice(root.length + 1)
          .replaceAll("\\", "/"),
      ),
  )
  .filter((p) => !/(^|\/)(node_modules|\.next[^/]*|test-results)\//.test(p))
  .filter((p) => !/\/(test|e2e)\/|\.(test|spec)\.tsx?$/.test(p));

describe("CLAUDE.md matches the repo", () => {
  it("names only paths that exist", () => {
    const named = claudeMd.match(
      /\b(apps|packages|fixtures|agents|plugins|docs|evals)\/[\w./-]+\.[a-z]+/g,
    );
    expect(named?.length).toBeGreaterThan(5);
    // Next's build folder is gitignored, so a clean checkout doesn't have it.
    const tracked = named!.filter((p) => !p.includes("/.next"));
    expect(tracked.filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });

  it("names every worker module", () => {
    const modules = readdirSync(join(root, "apps/worker/src")).filter((f) => f.endsWith(".ts"));
    expect(modules.length).toBeGreaterThan(5);
    expect(modules.filter((f) => !claudeMd.includes(f))).toEqual([]);
  });
});

describe("code conventions", () => {
  it(".env.example lists every variable the code reads", () => {
    const example = read(".env.example");
    const used = new Set(
      sources.flatMap((p) =>
        [...read(p).matchAll(/process\.env\.([A-Z_0-9]+)/g)].map((m) => m[1]!),
      ),
    );
    // Set by the platform or the test configs, never by the owner.
    for (const name of ["CI", "NEXT_DIST_DIR"]) used.delete(name);
    expect(used.size).toBeGreaterThan(3);
    expect([...used].filter((v) => !new RegExp(`\\b${v}\\b`).test(example))).toEqual([]);
  });

  it("every [id] route validates its param", () => {
    const routes = sources.filter((p) => /\/\[id\]\/.*route\.ts$|\/\[id\]\/route\.ts$/.test(p));
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.filter((p) => !read(p).includes("idParam"))).toEqual([]);
  });

  it("sorts tickets by position in byte order", () => {
    // Fractional-index keys only sort correctly with collate "C", which a bare asc() doesn't give.
    expect(
      sources.filter((p) => /\b(asc|desc|orderBy)\(\s*tickets\.position/.test(read(p))),
    ).toEqual([]);
  });
});
