import { expect, test, type Page } from "@playwright/test";

const column = (p: Page, name: string) => p.getByRole("region", { name, exact: true });
// The card itself (a button named "KEY-n: title"), not dnd-kit's drag-overlay copy that lingers while dropping.
const card = (p: Page, title: string) =>
  p.getByRole("button", { name: new RegExp(`-\\d+: ${title}$`) });

async function newBoard(page: Page) {
  const prefix = `P${Date.now().toString(36).toUpperCase().slice(-6)}`;
  await page.goto("/");
  await page.getByLabel("Name").fill("E2E agents");
  await page.getByLabel("Key prefix").fill(prefix);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/p\//);
  return prefix;
}

async function addTicket(page: Page, title: string) {
  await page.getByLabel("Quick add ticket").fill(title);
  await page.getByLabel("Quick add ticket").press("Enter");
  await expect(column(page, "Backlog").getByText(title)).toBeVisible();
}

async function drag(page: Page, title: string, toColumn: string) {
  const from = (await card(page, title).boundingBox())!;
  const to = (await column(page, toColumn).boundingBox())!;
  // Grab the middle: rectIntersection drops where the dragged card's rect overlaps most, in either direction.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
  await page.mouse.up();
}

// M2 done criterion: moving a ticket to Planning produces a plan artifact and a "Plan ready" flag.
test("moving a ticket to Planning runs Plan B: plan artifact, criteria, Plan ready", async ({
  page,
}) => {
  await newBoard(page);
  await expect(column(page, "Planning").getByRole("img", { name: "Plan B" })).toBeVisible();
  await addTicket(page, "Add a filter");

  await drag(page, "Add a filter", "Planning");
  await expect(page.getByLabel("Agent notice")).toHaveText("Plan B is on it.");
  await expect(column(page, "Planning").getByText("Plan ready · needs you")).toBeVisible();
  await expect(page.getByLabel("Tickets that need you")).toContainText("1");

  await card(page, "Add a filter").click();
  await expect(page.getByLabel("Latest run")).toContainText("plan-b · succeeded");
  await expect(page.getByLabel("Criterion", { exact: true })).toHaveCount(2); // written by the plan

  await page.getByRole("tab", { name: /Artifacts/ }).click();
  const plan = page.getByRole("article", { name: "Plan v1" });
  await expect(plan.getByRole("heading", { name: "Problem" })).toBeVisible(); // Markdown rendered

  await page.getByRole("tab", { name: "Live" }).click();
  const log = page.getByRole("list", { name: "Run log" });
  await expect(log).toContainText("started on claude-opus-5-5");
  await expect(log).toContainText("Reading the board component.");
  await expect(log).toContainText("→ Read");

  // UC-3: "Request changes" re-runs Plan B at once, no drag needed.
  await page.getByRole("tab", { name: /Artifacts/ }).click();
  await page.getByLabel("Requested plan changes").fill("Use SQLite, not Postgres");
  await page.getByRole("button", { name: "Revise plan" }).click();
  await expect(page.getByRole("article", { name: "Plan v2" })).toBeVisible();
  await expect(page.getByText("Plan v1 ·")).toBeVisible(); // v1 kept, collapsed
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText('requested plan changes: "Use SQLite, not Postgres"')).toBeVisible();
});

test("moving a ticket while its agent works asks first, then cancels the run", async ({ page }) => {
  await newBoard(page);
  await addTicket(page, "Slow plan");
  await card(page, "Slow plan").click();
  await page.getByPlaceholder("comma, separated").fill("replay:slow"); // plays fixtures/runs/plan-b/slow.json
  await page.getByPlaceholder("comma, separated").blur();
  await page.keyboard.press("Escape");
  await expect(column(page, "Backlog").getByText("replay:slow")).toBeVisible();

  await drag(page, "Slow plan", "Planning");
  await expect(column(page, "Planning").getByText("Working")).toBeVisible();

  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  // Keyboard move back to Backlog (same pattern as board.spec: wait on dnd-kit's announcements).
  const live = page.getByRole("status");
  await card(page, "Slow plan").focus();
  await page.keyboard.press("Space");
  await expect(live).toHaveText(/is over Planning\.$/);
  await expect(async () => {
    if ((await live.textContent())?.includes("over Planning"))
      await page.keyboard.press("ArrowLeft");
    await expect(live).toHaveText(/is over Backlog\.$/, { timeout: 250 });
  }).toPass();
  await page.keyboard.press("Space");
  // The optimistic move shows first; the server's 409 then asks before cancelling.
  await expect.poll(() => asked).toContain("plan-b is working on this ticket");
  await expect(column(page, "Backlog").getByText("Slow plan")).toBeVisible();
  await expect(column(page, "Backlog").getByText("Working")).toHaveCount(0);

  await card(page, "Slow plan").click();
  await expect(page.getByLabel("Latest run")).toContainText("plan-b · cancelled");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
