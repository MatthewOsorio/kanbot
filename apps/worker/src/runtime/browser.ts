import { tool } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { z } from "zod";
import { appRequestUrl } from "./fence";

const MAX_TEXT = 20_000; // page text the agent sees per call
const TIMEOUT = 5_000; // per click/type/read: a selector that matches nothing fails fast

export type SaveScreenshot = (name: string, png: Buffer) => Promise<void>;

/**
 * QA's headless browser into the running app (§4). The fence is here, not in the permission hook: every
 * request the context makes (navigations, clicks, redirects, subresources, page fetch/XHR, popups,
 * WebSockets) is aborted unless it is on the app's origin, and service workers, which would bypass
 * routing, are blocked.
 * shortcut: Chromium runs in the worker's process tree without its sandbox; move it into its own
 * container before Kanbot works on repos with unfamiliar code (§17 container isolation).
 */
export function appBrowser(appUrl: string, save?: SaveScreenshot) {
  const origin = new URL(appUrl).origin;
  const host = new URL(appUrl).host;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let errors: string[] = [];

  async function open(width: number, height: number): Promise<Page> {
    if (!page) {
      browser = await chromium.launch();
      context = await browser.newContext({
        viewport: { width, height },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        errors.push(`Blocked (not the app): ${url}`);
        return route.abort("blockedbyclient");
      });
      await context.routeWebSocket(/.*/, (ws) => {
        if (new URL(ws.url()).host === host) ws.connectToServer();
        else {
          errors.push(`Blocked WebSocket (not the app): ${ws.url()}`);
          ws.close({ code: 1008, reason: "Kanbot: only the app under test" });
        }
      });
      page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
      });
      page.on("pageerror", (e) => errors.push(`Uncaught: ${e.message}`));
    } else await page.setViewportSize({ width, height });
    return page;
  }

  const need = () => {
    if (!page) throw new Error("Open a page first with browser_open");
    return page;
  };

  /** Runs a tool body; appends the errors logged since the last call; turns throws into tool errors. */
  const call =
    <A>(fn: (a: A) => Promise<string | { text: string; png: Buffer }>) =>
    async (a: A) => {
      try {
        const r = await fn(a);
        const text = typeof r === "string" ? r : r.text;
        const logged = errors.length ? `\n\nErrors since the last call:\n${errors.join("\n")}` : "";
        errors = [];
        return {
          content: [
            { type: "text" as const, text: text + logged },
            ...(typeof r === "string"
              ? []
              : [
                  { type: "image" as const, data: r.png.toString("base64"), mimeType: "image/png" },
                ]),
          ],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
      }
    };

  const clipped = (s: string) =>
    s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… [${s.length} chars]` : s;
  const where = async (p: Page) => `URL: ${p.url()}\nTitle: ${await p.title()}`;

  const tools = [
    tool(
      "browser_open",
      `Open a page of the app under test (${appUrl}) in a headless browser at a given viewport size. Give a path, not a URL. Returns the visible text.`,
      {
        path: z.string().describe("Path and query, starting with /, e.g. / or /settings"),
        width: z
          .number()
          .int()
          .min(200)
          .max(3840)
          .default(1280)
          .describe("Viewport width, e.g. 375 for a phone"),
        height: z.number().int().min(200).max(2160).default(800),
      },
      call(async ({ path, width, height }) => {
        const url = appRequestUrl(appUrl, path);
        if (typeof url === "string") throw new Error(url);
        const p = await open(width, height);
        const r = await p.goto(url.href, { waitUntil: "load", timeout: 30_000 });
        return `${r?.status() ?? "no response"} at ${width}×${height}\n${await where(p)}\n\n${clipped(await p.locator("body").innerText())}`;
      }),
    ),
    tool(
      "browser_read",
      "Read the open page's accessibility tree (roles, names, text). With a selector, read that element and get its box against the viewport, to tell whether it is visible without scrolling.",
      {
        selector: z
          .string()
          .optional()
          .describe('Playwright selector: CSS, text=Save, role=button[name="Add"]'),
      },
      call(async ({ selector }) => {
        const p = need();
        const el = p.locator(selector ?? "body").first();
        const tree = clipped(await el.ariaSnapshot({ timeout: TIMEOUT }));
        if (!selector) return `${await where(p)}\n\n${tree}`;
        const box = await el.boundingBox();
        const vp = p.viewportSize();
        // A string: the worker has no DOM types.
        const doc = (await p.evaluate(
          "({ scrollY: window.scrollY, height: document.documentElement.scrollHeight })",
        )) as { scrollY: number; height: number };
        // Against the first screen, from the top of the page: "visible without scrolling".
        const top = box ? box.y + doc.scrollY : 0;
        const firstScreen =
          !!box &&
          !!vp &&
          top >= 0 &&
          box.x >= 0 &&
          top + box.height <= vp.height &&
          box.x + box.width <= vp.width;
        return [
          tree,
          `Box: ${box ? `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}` : "none (not rendered)"}`,
          `Viewport: ${vp?.width}×${vp?.height}, scrolled to y=${doc.scrollY}, page height ${doc.height}`,
          `Fully visible without scrolling (top of the page, this viewport): ${firstScreen ? "yes" : "no"}`,
        ].join("\n");
      }),
    ),
    tool(
      "browser_click",
      "Click an element on the open page.",
      { selector: z.string().describe('Playwright selector, e.g. role=button[name="Add"]') },
      call(async ({ selector }) => {
        const p = need();
        await p.locator(selector).first().click({ timeout: TIMEOUT });
        await p.waitForLoadState("load").catch(() => {});
        return `Clicked.\n${await where(p)}`;
      }),
    ),
    tool(
      "browser_type",
      "Type text into a field on the open page (replacing its value); optionally press Enter after.",
      {
        selector: z.string().describe('Playwright selector, e.g. role=textbox[name="Title"]'),
        text: z.string(),
        submit: z.boolean().default(false).describe("Press Enter after typing"),
      },
      call(async ({ selector, text, submit }) => {
        const p = need();
        const el = p.locator(selector).first();
        await el.fill(text, { timeout: TIMEOUT });
        if (submit) {
          await el.press("Enter", { timeout: TIMEOUT });
          await p.waitForLoadState("load").catch(() => {});
        }
        return `Typed.\n${await where(p)}`;
      }),
    ),
    tool(
      "browser_screenshot",
      "Take a screenshot of the open page (the viewport, or the full page). You see it, and it is attached to the ticket as evidence under this name.",
      {
        name: z.string().min(1).max(100).describe('What it shows, e.g. "Add button at 375px"'),
        fullPage: z.boolean().default(false),
      },
      call(async ({ name, fullPage }) => {
        const p = need();
        const png = await p.screenshot({ fullPage, timeout: 15_000 });
        await save?.(name, png);
        return { text: `Screenshot "${name}" saved to the ticket.\n${await where(p)}`, png };
      }),
    ),
  ];

  return {
    tools,
    async close() {
      await browser?.close().catch(() => {});
    },
  };
}
