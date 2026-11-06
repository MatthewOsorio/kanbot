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
  await expect(diff).toContainText(/Changed by\s*Sir Codes-a-Lot/); // who changed each file
  await expect(diff.getByRole("note")).toContainText("Add a regression test");
  await expect(diff.getByRole("note")).toContainText("Nitpick Nancy");
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

// §9 / FR-14: a confirmed "blocked by" link holds a ticket out of In Progress until the blocker is Done.
test("a confirmed blocker stops In Progress until it is Done", async ({ request }) => {
  const prefix = `K${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const project = await (
    await request.post("/api/projects", { data: { name: "Links", keyPrefix: prefix } })
  ).json();
  const ticket = async (title: string) =>
    (await (await request.post(`/api/projects/${project.id}/tickets`, { data: { title } })).json())
      .id as string;
  const board = async () => (await request.get(`/api/projects/${project.id}/board`)).json();
  const move = async (id: string, slug: string, extra = {}) => {
    const toColumnId = (await board()).columns.find((c: { slug: string }) => c.slug === slug).id;
    return request.post(`/api/tickets/${id}/move`, {
      data: { toColumnId, position: "a0", ...extra },
    });
  };
  const blocker = await ticket("Blocker");
  const blocked = await ticket("Blocked");

  const link = await request.post(`/api/tickets/${blocked}/links`, {
    data: { toKey: `${prefix}-1`, kind: "blocked_by" },
  });
  expect(link.status()).toBe(201);
  const { id: linkId } = await link.json();
  expect(
    (
      await request.post(`/api/tickets/${blocked}/links`, {
        data: { toKey: `${prefix}-1`, kind: "blocked_by" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.post(`/api/tickets/${blocked}/links`, {
        data: { toKey: `${prefix}-2`, kind: "relates" },
      })
    ).status(),
  ).toBe(400);

  const detail = async (id: string) => (await request.get(`/api/tickets/${id}`)).json();
  expect((await detail(blocked)).links).toEqual([
    expect.objectContaining({ relation: "blocked_by", key: `${prefix}-1`, confirmed: true }),
  ]);
  expect((await detail(blocker)).links).toEqual([
    expect.objectContaining({ relation: "blocks", key: `${prefix}-2` }),
  ]);

  await move(blocked, "ready");
  const cards = async () =>
    Object.fromEntries((await board()).tickets.map((t: { id: string }) => [t.id, t]));
  expect((await cards())[blocked].waitingOn).toEqual([`${prefix}-1`]);

  const refused = await move(blocked, "in_progress");
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toEqual({
    code: "overlap",
    message: `Waiting on ${prefix}-1`,
  });

  // Once the blocker is Done, the dependency no longer holds the ticket.
  await move(blocker, "done");
  expect((await cards())[blocked].waitingOn).toEqual([]);
  expect((await move(blocked, "in_progress")).status()).toBe(204);

  // Dismissing removes the link from both tickets.
  expect((await request.delete(`/api/links/${linkId}`)).status()).toBe(204);
  expect((await detail(blocked)).links).toEqual([]);
});

// UC-7 + FR-23: a ticket Blocked at the bounce limit gets a fresh count when the owner resumes the reviewer,
// so the reviewer's next change request bounces it again instead of blocking it straight away.
test("resuming a ticket blocked at the bounce limit resets its bounce count", async ({
  request,
}) => {
  const repo = await prepareSampleRepo(join(mkdtempSync(join(tmpdir(), "kanbot-e2e-")), "repo"));
  const project = await (
    await request.post("/api/projects", {
      data: {
        name: "Resume bounce",
        keyPrefix: `R${Date.now().toString(36).toUpperCase().slice(-6)}`,
        repoPath: repo,
      },
    })
  ).json();
  expect(
    (await request.patch(`/api/projects/${project.id}`, { data: { bounceLimit: 1 } })).ok(),
  ).toBe(true);
  const t = await (
    await request.post(`/api/projects/${project.id}/tickets`, {
      data: { title: "Always bounces", labels: ["replay:always"] },
    })
  ).json();
  const columnId = async (slug: string) =>
    (await (await request.get(`/api/projects/${project.id}/board`)).json()).columns.find(
      (c: { slug: string }) => c.slug === slug,
    ).id as string;
  const ticket = async () => (await request.get(`/api/tickets/${t.id}`)).json();
  const nancyRuns = async () =>
    (
      (await (await request.get(`/api/tickets/${t.id}/runs`)).json()) as {
        id: string;
        agentSlug: string;
      }[]
    ).filter((r) => r.agentSlug === "nitpick-nancy");
  const move = async (slug: string) =>
    request.post(`/api/tickets/${t.id}/move`, {
      data: { toColumnId: await columnId(slug), position: "a0" },
    });

  await move("planning");
  await expect.poll(async () => (await ticket()).statusFlag).toBe("plan_ready");
  expect((await move("in_progress")).status()).toBe(204);
  // Nancy #1 bounces (1 of 1), Nancy #2 finds the limit used up.
  await expect.poll(async () => (await nancyRuns()).length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await ticket()).columnId).toBe(await columnId("blocked"));
  await expect.poll(async () => (await ticket()).bounceCount).toBe(1);

  const [last] = await nancyRuns(); // newest first
  expect(
    (await request.post(`/api/runs/${last!.id}/resume`, { data: { answer: "" } })).status(),
  ).toBe(201);
  // Reset: Nancy #3 bounces it to In Progress, Sir Codes-a-Lot and Nancy #4 run, then it blocks again.
  // Without the reset Nancy #3 would block it at once and there would only be 3 runs.
  await expect.poll(async () => (await nancyRuns()).length, { timeout: 30_000 }).toBe(4);
  await expect.poll(async () => (await ticket()).columnId).toBe(await columnId("blocked"));
});
