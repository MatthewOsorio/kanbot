import { apiBase, loadGitHubApp, webBase } from "@kanbot/shared/github";
import { NextResponse, type NextRequest } from "next/server";
import { originOf, sessionCookie, STATE_COOKIE } from "@/lib/auth";
import { oauthReturn } from "@/lib/oauth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GitHub's OAuth redirect: only the account that created the App gets a session (§12). */
export async function GET(req: NextRequest) {
  const { code, fail } = oauthReturn(req);
  if (!code) return fail("state");
  const app = await loadGitHubApp(db);
  if (!app) return fail("no_app");

  const t = await fetch(`${webBase()}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: `${originOf(req)}/api/auth/callback`,
    }),
  });
  const token = ((await t.json().catch(() => ({}))) as { access_token?: string }).access_token;
  if (!token) return fail("github");
  // The user token is used once, to learn who signed in, and never stored.
  const u = await fetch(`${apiBase()}/user`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
  });
  const user = u.ok ? ((await u.json()) as { id?: number }) : {};
  if (user.id !== app.ownerId) return fail(u.ok ? "not_owner" : "github");

  const res = NextResponse.redirect(new URL("/", originOf(req)));
  res.cookies.set(...sessionCookie(originOf(req), user.id));
  res.cookies.delete(STATE_COOKIE);
  return res;
}
