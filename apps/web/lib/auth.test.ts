import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession, verifySession } from "./auth";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

afterEach(() => vi.unstubAllEnvs());

describe("session cookie", () => {
  it("returns the owner's id for a cookie we signed", () => {
    expect(verifySession(signSession(42, NOW), NOW)).toBe(42);
  });

  it("refuses a tampered signature", () => {
    const [body, sig] = signSession(42, NOW).split(".") as [string, string];
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifySession(`${body}.${flipped}`, NOW)).toBeNull();
  });

  it("refuses a body swapped under a valid signature", () => {
    const [, sig] = signSession(42, NOW).split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ uid: 1, exp: NOW + DAY })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, NOW)).toBeNull();
  });

  it("expires after 30 days", () => {
    const cookie = signSession(42, NOW);
    expect(verifySession(cookie, NOW + 29 * DAY)).toBe(42);
    expect(verifySession(cookie, NOW + 30 * DAY)).toBeNull();
  });

  it("refuses a cookie signed with another secret", () => {
    const cookie = signSession(42, NOW);
    vi.stubEnv("KANBOT_SESSION_SECRET", "a-completely-different-secret-0123456789");
    expect(verifySession(cookie, NOW)).toBeNull();
  });

  it.each([undefined, "", "no-dot", ".", "a.b.c"])("refuses %j", (cookie) => {
    expect(verifySession(cookie, NOW)).toBeNull();
  });

  it("won't run on a short secret", () => {
    vi.stubEnv("KANBOT_SESSION_SECRET", "short");
    expect(() => signSession(42, NOW)).toThrow(/at least 32/);
  });
});
