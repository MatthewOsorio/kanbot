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
  await card(page, title).scrollIntoViewIfNeeded(); // the drawer can leave the board scrolled
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
  await expect(page.getByRole("button", { name: /Needs me/ })).toContainText("1");

  await card(page, "Add a filter").click();
  await expect(page.getByLabel("Latest run")).toContainText("plan-b · succeeded");
  await expect(page.getByLabel("Criterion", { exact: true })).toHaveCount(2); // written by the plan

  await page.getByRole("tab", { name: /Artifacts/ }).click();
  const plan = page.getByRole("article", { name: "Plan: Add a filter v1" });
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
  await expect(page.getByRole("article", { name: "Plan: Add a filter v2" })).toBeVisible();
  await expect(page.getByText("Plan: Add a filter v1 ·")).toBeVisible(); // v1 kept, collapsed
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

  // FR-35: Retry takes the ticket back to the run's column and starts a fresh run there.
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Latest run")).toContainText(/plan-b · (queued|running)/);
  // The drawer is modal (the board behind it is hidden), so read the column from its header.
  await expect(page.getByRole("dialog").getByText(/-1 · Planning$/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel run" }).click(); // leave no slow run behind
  await expect(page.getByLabel("Latest run")).toContainText("plan-b · cancelled");
});

// Moving a planned ticket back to Planning asks before re-planning; Approve plan moves it to Ready.
test("back to Planning asks before Plan B redoes the plan; Approve plan moves to Ready", async ({
  page,
}) => {
  await newBoard(page);
  await addTicket(page, "Add a filter");
  await drag(page, "Add a filter", "Planning");
  await expect(column(page, "Planning").getByText("Plan ready · needs you")).toBeVisible();
  // Setup moves go through the API: pointer drags to the left are unreliable (see the keyboard move above).
  const projectId = page.url().split("/p/")[1]!;
  const toBacklog = async () => {
    const board = await (await page.request.get(`/api/projects/${projectId}/board`)).json();
    const backlog = board.columns.find((c: { slug: string }) => c.slug === "backlog").id;
    const res = await page.request.post(`/api/tickets/${board.tickets[0].id}/move`, {
      data: { toColumnId: backlog, position: "a0" },
    });
    expect(res.status()).toBe(204);
  };

  const answers: (boolean | string)[] = [];
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    const a = answers.shift();
    void (a === false ? d.dismiss() : d.accept(typeof a === "string" ? a : undefined));
  });

  // No: the plan is kept as is and nothing runs.
  await toBacklog();
  await expect(column(page, "Backlog").getByText("Add a filter")).toBeVisible();
  answers.push(false);
  await drag(page, "Add a filter", "Planning");
  await expect.poll(() => asked).toEqual([expect.stringContaining("already has a plan")]);
  await expect(column(page, "Planning").getByText("Plan ready · needs you")).toBeVisible();
  await card(page, "Add a filter").click();
  await expect(page.getByLabel("Latest run")).toContainText("plan-b · succeeded");
  await page.getByRole("tab", { name: /Artifacts/ }).click();
  await expect(page.getByRole("article", { name: "Plan: Add a filter v1" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Yes: Plan B revises the plan with the request.
  await toBacklog();
  await expect(column(page, "Backlog").getByText("Add a filter")).toBeVisible();
  answers.push(true, "Use SQLite, not Postgres");
  await drag(page, "Add a filter", "Planning");
  await expect(column(page, "Planning").getByText("Plan ready · needs you")).toBeVisible();
  await card(page, "Add a filter").click();
  await page.getByRole("tab", { name: /Artifacts/ }).click();
  await expect(page.getByRole("article", { name: "Plan: Add a filter v2" })).toBeVisible();

  // Approve plan: the same as dropping it on Ready.
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByRole("dialog").getByText(/-1 · Ready$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
});

// M4 done criterion: a needs_input run goes to Blocked, Duckworth asks, the owner answers and resumes.
test("a blocked ticket shows Duckworth's questions; Resume sends the answer back to the agent", async ({
  page,
}) => {
  await newBoard(page);
  await addTicket(page, "Pick a filter");
  await card(page, "Pick a filter").click();
  await page.getByLabel("Labels").fill("replay:needs-input");
  await page.getByLabel("Labels").blur();
  await expect(page.getByLabel("Labels")).toHaveValue("replay:needs-input");
  await page.keyboard.press("Escape");

  await drag(page, "Pick a filter", "Planning");
  await expect(column(page, "Blocked").getByText("Pick a filter")).toBeVisible();
  await page.getByRole("button", { name: /Needs me/ }).click();
  await page
    .getByRole("list", { name: "Tickets that need you" })
    .getByText("Pick a filter")
    .click();

  const blocked = page.getByRole("region", { name: "Blocker" });
  await expect(blocked.getByRole("heading", { name: "Questions" })).toBeVisible();
  await blocked.getByLabel("Your answer").fill("Title only.");
  await blocked.getByRole("button", { name: "Resume plan-b" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText('resumed plan-b with the answer "Title only."')).toBeVisible();
});
