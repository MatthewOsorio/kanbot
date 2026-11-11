import { randomBytes } from "node:crypto";
import { loadGitHubApp } from "@kanbot/shared/server";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, newState, originOf, STATE_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Click one of the two-click setup (§10): posts Kanbot's App manifest to github.com, where the owner
 * clicks Create. Only while no App is stored, so nobody can swap in their own App later.
 */
export async function GET(req: NextRequest) {
  if (await loadGitHubApp(db)) return NextResponse.redirect(new URL("/login", originOf(req)));
  const origin = originOf(req);
  const manifest = {
    name: `kanbot-${randomBytes(3).toString("hex")}`, // App names are unique across GitHub
    url: origin,
    redirect_url: `${origin}/api/github/callback`,
    callback_urls: [`${origin}/api/auth/callback`],
    setup_url: origin,
    public: false,
    // No webhook: GitHub refuses a localhost hook URL even when inactive, and Kanbot polls (§10).
    // shortcut: no hook_attributes/default_events, add them (or PATCH /app/hook/config) with a public server (M6).
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      workflows: "write",
      administration: "write",
      checks: "read",
      statuses: "read",
      metadata: "read",
    },
  };
  const state = newState();
  const action = `https://github.com/settings/apps/new?state=${state}`;
  const res = new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Connecting to GitHub…</title>
<form method="post" action="${action}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
<noscript><button>Continue to GitHub</button></noscript></form>
<script>document.forms[0].submit()</script>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
  res.cookies.set(STATE_COOKIE, state, cookieOptions(originOf(req), 600));
  return res;
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
