import { describe, expect, it } from "vitest";
import { createProjectBody } from "./schemas";
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
