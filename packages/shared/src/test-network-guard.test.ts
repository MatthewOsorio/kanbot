import { describe, expect, it } from "vitest";

describe("the test network guard", () => {
  it("refuses a real service", async () => {
    await expect(fetch("https://api.github.com/user")).rejects.toThrow(/Blocked network call/);
  });

  it("points GitHub at a dead local port by default", () => {
    expect(process.env.KANBOT_GITHUB_API).toBe("http://127.0.0.1:9");
  });
});
