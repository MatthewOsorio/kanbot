import { createDb, projects } from "@kanbot/shared/db";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { TEST_DATABASE_URL } from "../playwright.config";

// Onboarding a GitHub repo (§10) against the stub global-setup starts (octo/sample, cloned from a local repo).
test("a GitHub repo goes from the picker through setup to a ready board", async ({ page }) => {
  test.setTimeout(120_000);
  const db = createDb(TEST_DATABASE_URL);
  await db.delete(projects).where(eq(projects.githubOwner, "octo")); // earlier runs and worker tests
  await db.$client.end();

  await page.goto("/");
  const form = page.getByRole("form", { name: "From GitHub" });
  await form.getByLabel("GitHub repo").selectOption("octo/sample");
  await form.getByLabel("Key prefix").fill(`O${Date.now().toString(36).toUpperCase().slice(-6)}`);
  await form.getByRole("button", { name: "Set up project" }).click();
  await page.waitForURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up sample" })).toBeVisible();

  // Steps 3–4: the worker clones; project.yml's commands and the detected image are proposed.
  await expect(page.getByRole("textbox", { name: "test", exact: true })).toHaveValue(
    "node --test",
    { timeout: 30_000 },
  );
  await expect(page.getByLabel("Image")).toHaveValue("node:24-bookworm");
  // Host toolchain here (Docker isn't needed for e2e), and no install for a zero-dependency app.
  await page.getByLabel("Image").fill("");
  await page.getByRole("textbox", { name: "install", exact: true }).fill("");
  // QA runs the app (§4): without a start command, setup doesn't move on.
  const start = page.getByRole("textbox", { name: "start", exact: true });
  const startCommand = await start.inputValue();
  await start.fill("");
  await page.getByRole("button", { name: "Confirm and run the baseline" }).click();
  await expect(page.getByText(/QA needs the app running/)).toBeVisible();
  await start.fill(startCommand);
  // The example env file's name is proposed; its value is write-only from here on.
  await page.getByLabel("Value of KB_API_KEY").fill("e2e-secret-value");
  await page.getByRole("button", { name: "Confirm and run the baseline" }).click();

  // Step 5: the baseline ran on main.
  await expect(page.getByText("passed")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  const setup = await page.request.get(
    `${page
      .url()
      .replace("/p/", "/api/projects/")
      .replace(/\/setup$/, "")}/onboarding`,
  );
  expect(await setup.text()).not.toContain("e2e-secret-value");
  expect((await setup.json()).env).toEqual([{ name: "KB_API_KEY", set: true }]);

  // Step 6: no workflow yet, so Kanbot offers its starter as a PR; it reads the env from Actions secrets.
  await expect(page.getByText(/reads KB_API_KEY from the repo's Actions secrets/)).toBeVisible();
  await page.getByRole("button", { name: "Open CI pull request" }).click();
  await expect(page.getByRole("link", { name: "octo/sample/pull/1" })).toBeVisible();

  // Step 7: unprotected main; apply the rules.
  await expect(page.getByText(/lacks: a pull request with 1 approving review/)).toBeVisible();
  await page.getByRole("button", { name: "Apply protection" }).click();
  await expect(page.getByText("main is protected. Agents are on.")).toBeVisible();
  await page.getByRole("link", { name: "Open the board" }).click();
  await expect(page.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
  await expect(page.getByText("Finish setup")).toHaveCount(0);

  // Settings shows the stored value as set, never the value itself.
  await page.goto(page.url().replace(/\/?$/, "/settings"));
  await expect(page.getByLabel("Value of KB_API_KEY")).toHaveAttribute(
    "placeholder",
    "Set (type to replace)",
  );
  await expect(page.getByLabel("Value of KB_API_KEY")).toHaveValue("");
});
