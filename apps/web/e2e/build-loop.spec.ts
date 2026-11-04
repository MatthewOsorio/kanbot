import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSampleRepo } from "@kanbot/shared/db/testing";
import { expect, test, type Page } from "@playwright/test";

const column = (p: Page, name: string) => p.getByRole("region", { name, exact: true });
const card = (p: Page, title: string) =>
  p.getByRole("button", { name: new RegExp(`-\\d+: ${title}$`) });

// M3 done criterion: a ticket goes In Progress → Code Review → (bounce) → In Progress → Code Review → QA
// on its own, on a real git repo, with the replay worker playing fixtures/runs/*/bounce*.json.
test("the build loop runs to QA with one bounce, and the Diff tab shows the branch", async ({
  page,
}) => {
  const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-e2e-")), "repo"));
  await page.goto("/");
  await page.getByLabel("Name").fill("E2E build loop");
  await page.getByLabel("Key prefix").fill(`B${Date.now().toString(36).toUpperCase().slice(-6)}`);
  await page.getByPlaceholder("/home/you/code/my-app").fill(repo);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/p\//);
  const projectId = page.url().split("/p/")[1]!;

  const title = "Deleting an unknown todo removes the last one";
  // Labels pick the replay script; the quick-add box has no label field.
  const res = await page.request.post(`/api/projects/${projectId}/tickets`, {
    data: { title, type: "bug", labels: ["replay:bounce"] },
  });
  expect(res.ok()).toBe(true);
  await expect(column(page, "Backlog").getByText(title)).toBeVisible();

  const from = (await card(page, title).boundingBox())!;
  const to = (await column(page, "In Progress").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
  await page.mouse.up();

  const qa = column(page, "QA / Testing");
  await expect(qa.getByText(title)).toBeVisible({ timeout: 30_000 });
  await expect(qa.getByText("Approve · needs you")).toBeVisible();
  await expect(qa.getByText("↩ 1")).toBeVisible();

  await card(page, title).click();
  await page.getByRole("tab", { name: "Diff" }).click();
  const diff = page.getByLabel(/^Diff of kanbot\//);
  await expect(diff).toContainText("if (index === -1) return false;");
  await expect(diff.getByRole("note")).toContainText("Add a regression test");
  await expect(diff.getByRole("note")).toContainText("nitpick-nancy");
});

// §9 overlap check: entering In Progress while an in-flight ticket touches the same files is a 409
// until the owner starts anyway.
test("moving an overlapping ticket to In Progress asks to start anyway", async ({ page }) => {
  const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-e2e-")), "repo"));
  const prefix = `O${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const project = await (
    await page.request.post("/api/projects", {
      data: { name: "Overlap", keyPrefix: prefix, repoPath: repo },
    })
  ).json();
  const board = async () => (await page.request.get(`/api/projects/${project.id}/board`)).json();
  const col = async (slug: string) =>
    (await board()).columns.find((c: { slug: string }) => c.slug === slug).id as string;
  const move = (id: string, slug: string, extra = {}) =>
    col(slug).then((toColumnId) =>
      page.request.post(`/api/tickets/${id}/move`, {
        data: { toColumnId, position: "a0", ...extra },
      }),
    );
  const planned = async (title: string) => {
    const t = await (
      await page.request.post(`/api/projects/${project.id}/tickets`, {
        data: { title, labels: ["replay:bounce"] }, // Plan B's bounce plan touches src/todos.ts
      })
    ).json();
    await move(t.id, "planning");
    await expect
      .poll(async () => (await (await page.request.get(`/api/tickets/${t.id}`)).json()).statusFlag)
      .toBe("plan_ready");
    return t.id as string;
  };

  const a = await planned("First");
  const b = await planned("Second");
  expect((await move(a, "in_progress")).status()).toBe(204);
  const refused = await move(b, "in_progress");
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toEqual({
    code: "overlap",
    message: `Overlaps tickets in flight: ${prefix}-1 (2 files)`,
  });
  expect((await move(b, "in_progress", { startAnyway: true })).status()).toBe(204);
});
