import { apiBase, saveGitHubApp } from "@kanbot/shared/server";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { STATE_COOKIE } from "@/lib/auth";
import { oauthReturn } from "@/lib/oauth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const conversion = z.object({
  id: z.number(),
  slug: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  webhook_secret: z.string().nullable(),
  pem: z.string(),
  owner: z.object({ id: z.number(), login: z.string() }),
});

/**
 * GitHub sends the owner back here after Create (§10). The one-time code becomes the App's credentials,
 * stored encrypted; then click two, installing the App on the repos Kanbot will manage.
 */
export async function GET(req: NextRequest) {
  const { code, fail } = oauthReturn(req);
  if (!code) return fail("state");

  const r = await fetch(`${apiBase()}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json" },
  });
  if (!r.ok) return fail("github");
  const c = conversion.parse(await r.json());
  const saved = await saveGitHubApp(db, {
    id: c.id,
    slug: c.slug,
    clientId: c.client_id,
    clientSecret: c.client_secret,
    webhookSecret: c.webhook_secret,
    pem: c.pem,
    ownerId: c.owner.id,
    ownerLogin: c.owner.login,
  });
  if (!saved) return fail("exists");
  const res = NextResponse.redirect(`https://github.com/apps/${c.slug}/installations/new`);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
