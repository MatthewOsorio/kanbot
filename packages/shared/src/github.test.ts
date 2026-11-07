import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./github";

describe("encrypt", () => {
  beforeAll(() => {
    process.env.KANBOT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  it("round-trips, with a fresh iv each time", () => {
    const a = encrypt("-----BEGIN RSA PRIVATE KEY-----");
    expect(decrypt(a)).toBe("-----BEGIN RSA PRIVATE KEY-----");
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("refuses a tampered value or another key", () => {
    const b = Buffer.from(encrypt("secret"), "base64");
    b[b.length - 1]! ^= 1;
    expect(() => decrypt(b.toString("base64"))).toThrow();
    const v = encrypt("secret");
    process.env.KANBOT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decrypt(v)).toThrow();
  });

  it("refuses a missing or short key", () => {
    process.env.KANBOT_ENCRYPTION_KEY = "c2hvcnQ=";
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });
});
