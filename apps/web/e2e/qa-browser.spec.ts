import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSampleRepo } from "@kanbot/shared/db/testing";
import { expect, test } from "@playwright/test";

// §4: QA's browser screenshots show under the test report of the run that took them, and open full size.
// The replay worker plays fixtures/runs/testy-mctestface/qa-browser.json, which stores two real PNGs.
test("QA's screenshots show with its test report in the drawer", async ({ page, request }) => {
  const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-e2e-")), "repo"));
  const project = await (
    await request.post("/api/projects", {
      data: {
        name: "QA browser",
        keyPrefix: `Q${Date.now().toString(36).toUpperCase().slice(-6)}`,
        repoPath: repo,
      },
    })
  ).json();
  const title = "Add is visible on phones";
  const ticket = await (
    await request.post(`/api/projects/${project.id}/tickets`, {
      data: { title, labels: ["replay:qa-browser"] },
    })
  ).json();
  await request.post(`/api/tickets/${ticket.id}/criteria`, {
    data: { text: "Add is visible without scrolling on phones" },
  });
  const board = await (await request.get(`/api/projects/${project.id}/board`)).json();
  const qa = board.columns.find((c: { slug: string }) => c.slug === "qa").id;
  expect(
    (
      await request.post(`/api/tickets/${ticket.id}/move`, {
        data: { toColumnId: qa, position: "a0" },
      })
    ).status(),
  ).toBe(204);

  await page.goto(`/p/${project.id}`);
  await expect(page.getByText("Approve · needs you")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: new RegExp(`-\\d+: ${title}$`) }).click();
  await page.getByRole("tab", { name: /Artifacts/ }).click();
  const report = page.getByRole("article", { name: "Test report: Add button on phones v1" });
  const shots = report.getByRole("list", { name: "Screenshots" });
  await expect(shots.getByRole("img")).toHaveCount(2);
  const phone = shots.getByRole("img", { name: "Add at 375px, after adding Buy milk" });
  await expect(phone).toBeVisible();
  // The PNG really loads (lazily, so wait for it).
  await expect.poll(() => phone.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(375);

  const href = await shots.getByRole("link").first().getAttribute("href");
  const png = await request.get(href!);
  expect(png.headers()["content-type"]).toBe("image/png");
  expect((await request.get("/api/screenshots/not-a-uuid")).status()).toBe(404);
});
