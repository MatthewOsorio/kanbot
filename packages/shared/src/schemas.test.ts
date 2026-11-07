import { describe, expect, it } from "vitest";
import { createProjectBody, patchProjectBody } from "./schemas";
import { verdictPayload } from "./verdict";

const branch = (defaultBranch: string) =>
  createProjectBody.safeParse({ name: "x", keyPrefix: "XX", defaultBranch }).success;

describe("createProjectBody.defaultBranch", () => {
  it("accepts ordinary branch names", () => {
    for (const b of ["main", "master", "develop", "release/2.0", "feat/a-b_c"])
      expect(branch(b)).toBe(true);
  });

  // It becomes a git argument: an option-looking name would make `git show` write a file.
  it("refuses option-like and malformed names", () => {
    for (const b of [
      "--output=C:/x",
      "-c",
      "a..b",
      "a b",
      "a:b",
      "/main",
      "main/",
      "x@{1}",
      "a\\b",
    ])
      expect(branch(b)).toBe(false);
  });
});

describe("report_result relatedTickets", () => {
  const base = { verdict: "success", summary: "ok" };
  it("defaults to none and accepts blocks, blocked_by and relates", () => {
    expect(verdictPayload.parse(base).relatedTickets).toEqual([]);
    const ok = verdictPayload.safeParse({
      ...base,
      relatedTickets: ["blocks", "blocked_by", "relates"].map((kind) => ({ ticket: "KB-1", kind })),
    });
    expect(ok.success).toBe(true);
    expect(
      verdictPayload.safeParse({ ...base, relatedTickets: [{ ticket: "KB-1", kind: "x" }] })
        .success,
    ).toBe(false);
  });
});

describe("patchProjectBody", () => {
  const ok = (b: unknown) => patchProjectBody.safeParse(b).success;
  it("accepts plain commands, an empty command and in-range limits", () => {
    expect(ok({ commands: { test: "pnpm test", lint: "" }, bounceLimit: 10, concurrency: 1 })).toBe(
      true,
    );
  });
  it("refuses chained, piped or substituted commands (the fence would)", () => {
    for (const c of ["a && b", "a; b", "a | b", "a > f", "echo $HOME", "a `b`", "a\nb"])
      expect(ok({ commands: { test: c } })).toBe(false);
  });
  it("refuses out-of-range limits, empty groups and an empty body", () => {
    expect(ok({ bounceLimit: 0 })).toBe(false);
    expect(ok({ bounceLimit: 11 })).toBe(false);
    expect(ok({ concurrency: 5 })).toBe(false);
    expect(ok({ hotspots: [{ name: "api", paths: [] }] })).toBe(false);
    expect(ok({})).toBe(false);
  });
});

describe("patchProjectBody.env", () => {
  const env = (e: unknown) => patchProjectBody.safeParse({ env: e }).success;
  it("takes names with values, or null to keep the stored value", () => {
    expect(env({ API_KEY: "x", DB_URL: null, _A1: "" })).toBe(true);
  });
  it("refuses bad names, Kanbot's own vars and multi-line values", () => {
    for (const e of [{ "1A": "x" }, { "A-B": "x" }, { PORT: "1" }, { HOME: "/" }, { A: "a\nb" }])
      expect(env(e)).toBe(false);
  });
});
