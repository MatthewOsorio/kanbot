import { expect, test } from "@playwright/test";
import { SESSION_COOKIE } from "../lib/auth";

// Signed out: no session cookie (the other specs run with the owner's, from global-setup).
test.use({ storageState: { cookies: [], origins: [] } });

test("every route needs the owner's session (§12)", async ({ page, request }) => {
  const api = await request.get("/api/projects");
  expect(api.status()).toBe(401);
  expect((await api.json()).error.code).toBe("unauthorized");

  // A forged or tampered cookie is no better than none.
  const forged = await request.get("/api/projects", {
    headers: { cookie: `${SESSION_COOKIE}=eyJ1aWQiOjEsImV4cCI6OTk5OTk5OTk5OTk5OX0.bad` },
  });
  expect(forged.status()).toBe(401);

  // Pages send you to sign in; global-setup stored an App, so it offers Sign in, not Connect.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
    "href",
    "/api/auth/login",
  );
  await expect(page.getByText("e2e-owner")).toBeVisible();

  // With an App already connected, setup can't be run again to swap it.
  const setup = await request.get("/api/github/setup", { maxRedirects: 0 });
  expect(setup.status()).toBe(307);
  expect(setup.headers().location).toMatch(/\/login$/);
});

test("a GitHub callback with the wrong state is refused", async ({ page }) => {
  await page.goto("/api/auth/callback?code=x&state=forged");
  await expect(page).toHaveURL(/\/login\?error=state$/);
  await expect(page.getByText("That sign-in link expired")).toBeVisible();
});
