import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_HOSTS, originOf, SESSION_COOKIE, verifySession } from "@/lib/auth";

// Binding to 127.0.0.1 doesn't stop a browser tab: a DNS-rebound host would read our pages and API, and a
// cross-site POST needs no preflight. So only local Host names get in, and writes must come from our own
// origin (browsers always send Origin on POST/PATCH/DELETE). Then every route needs the owner's session
// (requirements §12), except the login page and the GitHub round trips that create it. The GitHub App
// setup is open only while no App exists (its route checks), and only on localhost by the Host rule.
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
// Next's own assets need no session.
const OPEN = [
  "/_next/",
  "/favicon.ico",
  "/login",
  "/api/auth/",
  "/api/github/setup",
  "/api/github/callback",
];

const forbidden = (message: string) =>
  Response.json({ error: { code: "forbidden", message } }, { status: 403 });

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!LOCAL_HOSTS.has(hostname(host))) return forbidden("Kanbot only answers on localhost");
  const origin = req.headers.get("origin");
  if (!SAFE.has(req.method) && origin && hostOf(origin) !== host)
    return forbidden("Cross-site requests are not allowed");

  const path = req.nextUrl.pathname;
  if (OPEN.some((p) => path === p || (p.endsWith("/") && path.startsWith(p)))) return;
  if (verifySession(req.cookies.get(SESSION_COOKIE)?.value) !== null) return;
  if (path.startsWith("/api/"))
    return Response.json(
      { error: { code: "unauthorized", message: "Sign in with GitHub first" } },
      { status: 401 },
    );
  return NextResponse.redirect(new URL("/login", originOf(req)));
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
