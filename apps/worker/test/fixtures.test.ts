import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replayScript } from "../src/runtime/replay";

const root = resolve(__dirname, "../../../fixtures/runs");
const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
  f.endsWith(".json"),
);

describe("replay fixtures", () => {
  it("finds them", () => expect(files.length).toBeGreaterThan(0));

  it.each(files)("%s is a valid script", (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
    expect(replayScript.safeParse(raw).error).toBeUndefined();
  });
});
