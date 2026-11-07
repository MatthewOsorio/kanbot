import { NextResponse, type NextRequest } from "next/server";
import { originOf, SESSION_COOKIE } from "@/lib/auth";

/** A form POST (the proxy refuses cross-site ones), so a link on another site can't sign the owner out. */
export function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", originOf(req)), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
