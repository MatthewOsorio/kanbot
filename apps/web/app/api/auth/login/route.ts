import { loadGitHubApp } from "@kanbot/shared/server";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, newState, originOf, STATE_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Sign in with GitHub (§12) through the Kanbot App's OAuth side. */
export async function GET(req: NextRequest) {
  const app = await loadGitHubApp(db);
  if (!app) return NextResponse.redirect(new URL("/login", originOf(req)));
  const state = newState();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", `${originOf(req)}/api/auth/callback`);
  url.searchParams.set("state", state);
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, state, cookieOptions(originOf(req), 600));
  return res;
}
