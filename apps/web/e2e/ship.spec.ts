import { createDb, projects, tickets } from "@kanbot/shared/db";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { TEST_DATABASE_URL } from "../playwright.config";

// §3 manual moves around Ship (M5 phase 5a): skipping the gates asks first, PR Review needs a PR, and
// Done with an open PR closes it on GitHub (the stub) once confirmed. The card and drawer show the PR.
test("Ship, PR Review and Done confirmations, and the PR on the card and drawer", async ({
  page,
}) => {
  const request = page.request;
  const prefix = `P${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const project = await (
    await request.post("/api/projects", { data: { name: "Ship moves", keyPrefix: prefix } })
  ).json();
  const t = await (
    await request.post(`/api/projects/${project.id}/tickets`, { data: { title: "Ship me" } })
  ).json();
  const columnId = async (slug: string) =>
    (await (await request.get(`/api/projects/${project.id}/board`)).json()).columns.find(
      (c: { slug: string }) => c.slug === slug,
    ).id as string;
  const move = async (slug: string, extra = {}) =>
    request.post(`/api/tickets/${t.id}/move`, {
      data: { toColumnId: await columnId(slug), position: "a0", ...extra },
    });

  const skip = await move("ship");
  expect(skip.status()).toBe(409);
  expect((await skip.json()).error.code).toBe("skip_gates");
  expect((await move("ship", { confirmSkip: true })).status()).toBe(204);

  const noPr = await move("pr_review");
  expect(noPr.status()).toBe(409);
  expect((await noPr.json()).error.code).toBe("no_pr");

  // As if Ship had opened PR #7 on the stub's octo/sample.
  const db = createDb(TEST_DATABASE_URL);
  await db
    .update(projects)
    .set({
      githubOwner: "octo",
      githubRepo: "sample",
      onboarding: { step: "ready", state: "waiting" },
    })
    .where(eq(projects.id, project.id));
  await db
    .update(tickets)
    .set({ prNumber: 7, prUrl: "https://github.com/octo/sample/pull/7", statusFlag: "pr_open" })
    .where(eq(tickets.id, t.id));
  await db.$client.end();

  await page.goto(`/p/${project.id}`);
  const card = page.getByRole("button", { name: `${prefix}-1: Ship me` });
  await expect(card.getByText("PR #7")).toBeVisible();
  await expect(card.getByText("PR open · waiting on CI")).toBeVisible();
  await card.click();
  await expect(page.getByRole("link", { name: "PR #7 on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/octo/sample/pull/7",
  );
  await page.keyboard.press("Escape");

  expect((await move("pr_review")).status()).toBe(204);
  const open = await move("done");
  expect(open.status()).toBe(409);
  expect((await open.json()).error).toEqual({
    code: "pr_open",
    message: "Its PR #7 is still open",
  });
  expect((await move("done", { confirmClose: true })).status()).toBe(204);
  const activity = await (await request.get(`/api/tickets/${t.id}/activity`)).json();
  expect(activity.map((a: { action: string }) => a.action)).toContain("pr_closed");
  // Closed now: moving it out of Done and back asks nothing more about the PR. Archie may still be at work
  // on Done when the replay worker is busy (the full suite), hence confirmCancel.
  expect((await move("pr_review", { confirmCancel: true })).status()).toBe(204);
  expect((await move("done", { confirmCancel: true })).status()).toBe(204);
});
