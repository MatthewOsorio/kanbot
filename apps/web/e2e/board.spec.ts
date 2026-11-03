import { expect, test, type Page } from "@playwright/test";

const column = (p: Page, name: string) => p.getByRole("region", { name, exact: true });

// M1 done-criterion: tickets can be created and moved, and the board updates live in two tabs.
test("create and move a ticket; a second tab updates live", async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const prefix = `E${Date.now().toString(36).toUpperCase().slice(-6)}`;

  await a.goto("/");
  await a.getByLabel("Name").fill("E2E board");
  await a.getByLabel("Key prefix").fill(prefix);
  await a.getByRole("button", { name: "Create project" }).click();
  await a.waitForURL(/\/p\//);
  await expect(column(a, "Backlog")).toBeVisible();

  const b = await ctx.newPage();
  await b.goto(a.url());
  await expect(column(b, "Backlog")).toBeVisible();

  // Create in tab A, appears live in tab B.
  await a.getByLabel("Quick add ticket").fill("Live ticket");
  await a.getByLabel("Quick add ticket").press("Enter");
  await expect(column(b, "Backlog").getByText("Live ticket")).toBeVisible();

  // Criterion and comment through the drawer.
  const card = column(a, "Backlog").getByRole("button", { name: `${prefix}-1: Live ticket` });
  await card.click();
  await a.getByLabel("New criterion").fill("It moves");
  await a.getByLabel("New criterion").press("Enter");
  await expect(a.getByLabel("Criterion", { exact: true })).toHaveValue("It moves");
  await a.getByLabel("New comment").fill("Looks good");
  await a.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(a.getByText("Looks good")).toBeVisible();
  await a.keyboard.press("Escape");

  // Keyboard drag (accessibility NFR): Space picks up, ArrowRight moves a column, Space drops.
  // Steps wait on dnd-kit's live-region announcements, so keys never outrun the drag.
  const live = a.getByRole("status");
  await card.focus();
  await a.keyboard.press("Space");
  await expect(live).toHaveText(`${prefix}-1 is over Backlog.`);
  // dnd-kit binds its arrow-key listener an effect after pickup; re-press only while still over Backlog, so it can't overshoot.
  await expect(async () => {
    if ((await live.textContent())?.includes("over Backlog")) await a.keyboard.press("ArrowRight");
    await expect(live).toHaveText(`${prefix}-1 is over Planning.`, { timeout: 250 });
  }).toPass();
  await a.keyboard.press("Space");

  await expect(column(b, "Planning").getByText("Live ticket")).toBeVisible();
  await expect(column(b, "Backlog").getByText("Live ticket")).toHaveCount(0);
  await b.reload();
  await expect(column(b, "Planning").getByText("Live ticket")).toBeVisible();

  // Pointer drag in tab B to Ready shows up live in tab A.
  const from = (await column(b, "Planning").getByText("Live ticket").boundingBox())!;
  const to = (await column(b, "Ready").boundingBox())!;
  await b.mouse.move(from.x + 5, from.y + 5);
  await b.mouse.down();
  await b.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
  await b.mouse.up();
  await expect(column(a, "Ready").getByText("Live ticket")).toBeVisible();
});
