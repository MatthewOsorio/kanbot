// Apart from auth.ts because e2e's global setup imports that outside Next, where next/server won't resolve.
import { NextResponse, type NextRequest } from "next/server";
import { originOf, STATE_COOKIE } from "./auth";

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
