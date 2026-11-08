// Sign in with GitHub (requirements §12): a signed, HTTP-only session cookie. No session table: the cookie
// carries the owner's GitHub id and an expiry, and its HMAC proves Kanbot issued it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const SESSION_COOKIE = "kanbot_session";
const MAX_AGE = 30 * 24 * 3600;

function secret(): string {
  const s = process.env.KANBOT_SESSION_SECRET ?? "";
  if (s.length < 32)
    throw new Error(
      "KANBOT_SESSION_SECRET must be at least 32 characters (openssl rand -base64 32)",
    );
  return s;
}

const mac = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export function signSession(uid: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ uid, exp: now + MAX_AGE * 1000 })).toString(
    "base64url",
  );
  return `${body}.${mac(body)}`;
}

/** The owner's GitHub id if the cookie is ours and not expired, else null. */
export function verifySession(cookie: string | undefined, now = Date.now()): number | null {
  const [body, sig] = cookie?.split(".") ?? [];
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      uid: number;
      exp: number;
    };
    return exp > now && Number.isInteger(uid) ? uid : null;
  } catch {
    return null;
  }
}

export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Secure everywhere but this machine, where Kanbot is plain http. Judged by host, not protocol: behind
 * Caddy the request reaches Next over http. */
export function cookieOptions(url: string, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !LOCAL_HOSTS.has(new URL(url).hostname),
    path: "/",
    maxAge,
  };
}

export const sessionCookie = (url: string, uid: number) =>
  [SESSION_COOKIE, signSession(uid), cookieOptions(url, MAX_AGE)] as const;

/** One-time `state` for the GitHub round trips (CSRF): set in a short cookie, compared on the way back. */
export const newState = () => randomBytes(16).toString("base64url");
export const STATE_COOKIE = "kanbot_oauth_state";

/** The origin the browser used. Next's `req.url` names its own bind host (`localhost` for 127.0.0.1), and
 * cookies set on one host aren't sent to the other. The proxy has already checked Host. */
export const originOf = (req: Request) =>
  `${new URL(req.url).protocol}//${req.headers.get("host") ?? new URL(req.url).host}`;

/** GitHub's redirect back to us: its `code` (null if the state cookie doesn't match), and `fail` to send the owner to /login. */
export function oauthReturn(req: NextRequest) {
  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, originOf(req)));
    res.cookies.delete(STATE_COOKIE);
    return res;
  };
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  return { fail, code: state && state === req.cookies.get(STATE_COOKIE)?.value ? code : null };
}
