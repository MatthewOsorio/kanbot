import { describe, expect, it } from "vitest";
import { createProjectBody } from "./schemas";

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
