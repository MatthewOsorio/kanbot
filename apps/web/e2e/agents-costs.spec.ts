import { expect, test } from "@playwright/test";

// This reads the repo's real agents/ folder, so it never saves a valid edit; it only tries an invalid one.
test("the Agents page lists the roster, and an invalid edit is refused with the file left alone", async ({
  page,
}) => {
  await page.goto("/agents");
  await expect(page.getByRole("button", { name: /Plan B/ })).toBeVisible();
  await page.getByRole("button", { name: /Plan B/ }).click();
  const editor = page.getByLabel("Agent file");
  await expect(editor).toHaveValue(/^---/);
  const before = await editor.inputValue();

  await editor.fill(before.replace(/^slug: .*$/m, "slug: someone-else"));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText('slug must stay "plan-b"')).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /Plan B/ }).click();
  await expect(page.getByLabel("Agent file")).toHaveValue(before);
});

test("the Costs page shows a report and switches the grouping", async ({ page }) => {
  await page.goto("/costs");
  await expect(page.getByRole("heading", { name: "Costs" })).toBeVisible();
  await expect(page.getByText(/over \d+ runs/)).toBeVisible();
  await page.getByRole("button", { name: "By agent" }).click();
  await expect(page.getByRole("columnheader", { name: "agent" })).toBeVisible();
});
