import { describe, expect, it } from "vitest";
import { branchName, devcontainer, overlap } from "./repo";

describe("devcontainer", () => {
  it("reads the image from JSONC, and nothing it can't trust", () => {
    const jsonc = `{\n  // the base\n  "image": "mcr.microsoft.com/devcontainers/go:1-1.22",\n  "features": {},\n}`;
    expect(devcontainer(jsonc)).toEqual({ image: "mcr.microsoft.com/devcontainers/go:1-1.22" });
    expect(devcontainer(`{"image": "--privileged"}`)).toBeUndefined(); // would be a docker flag
    expect(devcontainer("")).toBeUndefined();
    expect(devcontainer("{ not json")).toBeUndefined();
  });

  it("reads the Dockerfile it builds, with paths made repo-relative", () => {
    const build = (b: object) => devcontainer(JSON.stringify({ build: b }));
    expect(build({ dockerfile: "Dockerfile" })).toEqual({
      dockerfile: { file: ".devcontainer/Dockerfile", context: ".devcontainer" },
    });
    expect(build({ dockerfile: "Dockerfile", context: ".." })).toEqual({
      dockerfile: { file: ".devcontainer/Dockerfile", context: "." },
    });
    expect(devcontainer(`{"dockerFile": "../docker/dev.Dockerfile", "context": "x"}`)).toEqual({
      dockerfile: { file: "docker/dev.Dockerfile", context: ".devcontainer/x" },
    });
    expect(build({ dockerfile: "Dockerfile", context: "../.." })).toBeUndefined(); // outside the repo
    expect(build({ dockerfile: "/etc/Dockerfile" })).toBeUndefined();
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
