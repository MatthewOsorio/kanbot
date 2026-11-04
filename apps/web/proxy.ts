import type { NextRequest } from "next/server";

// No auth until M4 (requirements §14), and binding to 127.0.0.1 doesn't stop a browser tab: a DNS-rebound
// host would read our pages and API, and a cross-site POST needs no preflight. So only local Host names
// get in, and writes must come from our own origin (browsers always send Origin on POST/PATCH/DELETE).
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const forbidden = (message: string) =>
  Response.json({ error: { code: "forbidden", message } }, { status: 403 });

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!LOCAL.has(hostname(host))) return forbidden("Kanbot only answers on localhost");
  const origin = req.headers.get("origin");
  if (!SAFE.has(req.method) && origin && hostOf(origin) !== host)
    return forbidden("Cross-site requests are not allowed");
}

const hostname = (host: string) => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
};

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return null; // "null" origins (sandboxed iframes, file://) are cross-site too
  }
};
