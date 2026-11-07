import { expect, test, type Page } from "@playwright/test";
import { request } from "node:http";
import { SESSION_COOKIE, signSession } from "../lib/auth";
import { OWNER_ID } from "./global-setup";

const column = (p: Page, name: string) => p.getByRole("region", { name, exact: true });

// M1 done-criterion: tickets can be created and moved, and the board updates live in two tabs.
test("create and move a ticket; a second tab updates live", async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const prefix = `E${Date.now().toString(36).toUpperCase().slice(-6)}`;

  await a.goto("/");
  await a.getByText("Use a local folder instead").click();
  const form = a.getByRole("form", { name: "Local folder" });
  await form.getByLabel("Name").fill("E2E board");
  await form.getByLabel("Key prefix").fill(prefix);
  await form.getByRole("button", { name: "Create project" }).click();
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
  await a.getByRole("tab", { name: /Comments/ }).click();
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

  // Planning starts Plan B (replay runtime); wait for its plan so the next move needs no cancel.
  await expect(column(b, "Planning").getByText("Plan ready · needs you")).toBeVisible();

  // Pointer drag in tab B to Ready shows up live in tab A.
  const from = (await column(b, "Planning").getByText("Live ticket").boundingBox())!;
  const to = (await column(b, "Ready").boundingBox())!;
  await b.mouse.move(from.x + 5, from.y + 5);
  await b.mouse.down();
  await b.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
  await b.mouse.up();
  await expect(column(a, "Ready").getByText("Live ticket")).toBeVisible();
});

// Even with the owner's session, a DNS-rebound Host or a cross-site POST must not reach the API (proxy.ts).
test("refuses foreign hosts and cross-site writes", async ({ baseURL }) => {
  const send = (method: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const cookie = `${SESSION_COOKIE}=${signSession(OWNER_ID)}`;
      const opts = { method, headers: { cookie, ...headers } };
      const req = request(new URL("/api/projects", baseURL), opts, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end(method === "POST" ? '{"name":"x","keyPrefix":"XX"}' : undefined);
    });
  const host = new URL(baseURL!).host;
  expect(await send("GET", { host })).toBe(200);
  expect(await send("GET", { host: "evil.test" })).toBe(403);
  expect(
    await send("POST", { host, origin: "http://evil.test", "content-type": "text/plain" }),
  ).toBe(403);
});

test("project settings: seeded as empty, an empty command clears, a chained one is refused", async ({
  request,
}) => {
  const key = `S${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const p = await (
    await request.post("/api/projects", { data: { name: "Settings", keyPrefix: key } })
  ).json();
  const url = `/api/projects/${p.id}`;
  const patch = (data: object) => request.patch(url, { data });
  expect((await patch({ commands: { test: "a && b" } })).status()).toBe(400);
  const ok = await patch({
    commands: { test: "pnpm test", lint: "" },
    bounceLimit: 2,
    concurrency: 2,
  });
  expect(await ok.json()).toMatchObject({
    commands: { test: "pnpm test" },
    bounceLimit: 2,
    concurrency: 2,
  });
  const cleared = await patch({ commands: { test: "" } });
  expect((await cleared.json()).commands).toEqual({});
  expect((await (await request.get(url)).json()).bounceLimit).toBe(2);
  // The image (§7): a docker flag is refused, "" clears it.
  expect((await patch({ image: "--privileged" })).status()).toBe(400);
  expect((await (await patch({ image: "node:24-alpine" })).json()).image).toBe("node:24-alpine");
  expect((await (await patch({ bounceLimit: 3 })).json()).image).toBe("node:24-alpine");
  expect((await (await patch({ image: "" })).json()).image).toBe("");
});
