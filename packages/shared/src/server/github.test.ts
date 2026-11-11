import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { appJwt, decrypt, encrypt, ghAll } from "./github";

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

describe("ghAll", () => {
  it("asks for pages until one comes back short, for arrays and for keyed bodies", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      seen.push(url.pathname + url.search);
      const page = Number(url.searchParams.get("page"));
      const items = Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({
        id: page * 1000 + i,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(url.pathname === "/wrapped" ? { things: items } : items));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const before = process.env.KANBOT_GITHUB_API;
    process.env.KANBOT_GITHUB_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await ghAll("t", "/plain")).toHaveLength(103);
      expect(await ghAll("t", "/wrapped?x=1", "things")).toHaveLength(103);
      expect(seen).toEqual([
        "/plain?per_page=100&page=1",
        "/plain?per_page=100&page=2",
        "/wrapped?x=1&per_page=100&page=1",
        "/wrapped?x=1&per_page=100&page=2",
      ]);
    } finally {
      process.env.KANBOT_GITHUB_API = before;
      await new Promise((ok) => server.close(ok));
    }
  });
});
