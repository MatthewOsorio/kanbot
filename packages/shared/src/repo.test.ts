import { describe, expect, it } from "vitest";
import { branchName, devcontainerImage, overlap } from "./repo";

describe("devcontainerImage", () => {
  it("reads the image from JSONC, and nothing it can't trust", () => {
    const jsonc = `{\n  // the base\n  "image": "mcr.microsoft.com/devcontainers/go:1-1.22",\n  "features": {},\n}`;
    expect(devcontainerImage(jsonc)).toBe("mcr.microsoft.com/devcontainers/go:1-1.22");
    expect(devcontainerImage(`{"build": {"dockerfile": "Dockerfile"}}`)).toBeUndefined();
    expect(devcontainerImage(`{"image": "--privileged"}`)).toBeUndefined(); // would be a docker flag
    expect(devcontainerImage("")).toBeUndefined();
  });
});

const hotspots = [{ name: "database", paths: ["db/schema.ts", "db/migrations/**"] }];

describe("overlap", () => {
  it("finds shared files, glob matches and folders", () => {
    expect(overlap(["src/a.ts", "README.md"], ["src/a.ts"], []).files).toEqual(["src/a.ts"]);
    expect(overlap(["src/**/*.ts"], ["src/x/b.ts"], []).files).toEqual(["src/**/*.ts"]);
    expect(overlap(["src/x/b.ts"], ["src/"], []).files).toEqual(["src/x/b.ts"]);
    expect(overlap(["src/a.ts"], ["test/a.test.ts"], []).files).toEqual([]);
  });
  it("finds a hotspot both tickets touch, even with no shared file", () => {
    expect(overlap(["db/schema.ts"], ["db/migrations/0001.sql"], hotspots)).toEqual({
      files: [],
      hotspots: ["database"],
    });
    expect(overlap(["db/schema.ts"], ["src/a.ts"], hotspots).hotspots).toEqual([]);
  });
});

describe("branchName", () => {
  it("is kanbot/<key>-<slug>", () => {
    expect(branchName("KB-12", "Add a CSV export, please!")).toBe(
      "kanbot/KB-12-add-a-csv-export-please",
    );
    expect(branchName("KB-1", "???")).toBe("kanbot/KB-1-ticket");
  });
});
