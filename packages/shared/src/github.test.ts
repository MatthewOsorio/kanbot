import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { appJwt, decrypt, encrypt } from "./github";

describe("encrypt", () => {
  beforeEach(() => {
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

describe("appJwt", () => {
  it("is an RS256 token GitHub can verify with the App's public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = appJwt({ id: 42, pem }, 1_000_000_000_000);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
      iat: 999_999_940,
      exp: 1_000_000_540,
      iss: "42",
    });
    expect(
      createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig!, "base64url"),
    ).toBe(true);
  });
});
