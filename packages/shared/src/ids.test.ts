import { describe, expect, it, vi } from "vitest";
import { uuidv7 } from "./ids";

describe("uuidv7", () => {
  it("has the v7 version and RFC variant bits", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("encodes the timestamp so later ids sort after earlier ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const a = uuidv7();
    vi.setSystemTime(1_800_000_000_001);
    const b = uuidv7();
    vi.useRealTimers();
    expect(a.replaceAll("-", "").slice(0, 12)).toBe(
      (1_800_000_000_000).toString(16).padStart(12, "0"),
    );
    expect(a < b).toBe(true);
  });
});
