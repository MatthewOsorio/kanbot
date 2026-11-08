import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession } from "./lib/auth";
import { proxy } from "./proxy";

const LOCAL = "127.0.0.1:3000";

function request(
  path: string,
  o: { method?: string; host?: string; origin?: string; signedIn?: boolean } = {},
) {
  const headers: Record<string, string> = { host: o.host ?? LOCAL };
  if (o.origin) headers.origin = o.origin;
  if (o.signedIn) headers.cookie = `${SESSION_COOKIE}=${signSession(1)}`;
  return new NextRequest(`http://${LOCAL}${path}`, { method: o.method ?? "GET", headers });
}

describe("proxy", () => {
  it.each(["evil.example", "kanbot.example:3000"])("refuses Host %s, even signed in", (host) => {
    expect(proxy(request("/api/projects", { host, signedIn: true }))?.status).toBe(403);
  });

  it("refuses a cross-site write, even signed in", () => {
    const req = request("/api/projects", {
      method: "POST",
      origin: "http://evil.example",
      signedIn: true,
    });
    expect(proxy(req)?.status).toBe(403);
  });

  it("refuses a write from a null origin", () => {
    const req = request("/api/projects", { method: "POST", origin: "null", signedIn: true });
    expect(proxy(req)?.status).toBe(403);
  });

  it("lets the owner through, same-origin writes included", () => {
    expect(proxy(request("/api/projects", { signedIn: true }))).toBeUndefined();
    const write = request("/api/projects", {
      method: "POST",
      origin: `http://${LOCAL}`,
      signedIn: true,
    });
    expect(proxy(write)).toBeUndefined();
  });

  it("answers 401 on the API and redirects pages when signed out", () => {
    expect(proxy(request("/api/projects"))?.status).toBe(401);
    const page = proxy(request("/p/some-project"));
    expect(page?.status).toBe(307);
    expect(page?.headers.get("location")).toMatch(/\/login$/);
  });

  it.each(["/login", "/_next/static/a.js", "/api/auth/login", "/api/github/setup"])(
    "leaves %s open",
    (path) => {
      expect(proxy(request(path))).toBeUndefined();
    },
  );

  it.each(["/loginx", "/api/authx", "/api/github/setup/more", "/api/github/repos"])(
    "doesn't treat %s as open",
    (path) => {
      expect(proxy(request(path))).not.toBeUndefined();
    },
  );
});
