import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appBrowser } from "../src/runtime/browser";
import { startApp } from "../src/qa-app";

// Needs Docker (the app runs in its image, as in QA) and Playwright's Chromium (CI installs it for e2e).
const hasDocker = (() => {
  try {
    return !!execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
    });
  } catch {
    return false;
  }
})();
const hasChromium = existsSync(chromium.executablePath());
if (process.env.CI && (!hasDocker || !hasChromium)) throw new Error("CI needs Docker and Chromium");

type Result = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

describe.skipIf(!hasDocker || !hasChromium)("QA's browser (§4), real Chromium", () => {
  let dir: string;
  let app: { url: string; stop: () => Promise<void> };
  let outside: Server;
  const hits: string[] = []; // every request that reached the other origin, WebSocket upgrades included
  const saved: { name: string; png: Buffer }[] = [];
  let b: ReturnType<typeof appBrowser>;
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = b.tools.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as Result;
    return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
  };

  beforeAll(async () => {
    // Another origin on the same machine, which the browser must never reach.
    outside = createServer((q, s) => {
      hits.push(q.url ?? "");
      s.end("leaked");
    }).on("upgrade", (q, sock) => {
      hits.push(`ws ${q.url}`);
      sock.destroy();
    });
    await new Promise<void>((r) => outside.listen(0, "127.0.0.1", r));
    const out = `127.0.0.1:${(outside.address() as { port: number }).port}`;

    dir = mkdtempSync(join(tmpdir(), "kanbot-browser-"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><title>Tiny</title>
<h1>Tiny app</h1>
<label>Name <input id="name"></label>
<button onclick="document.querySelector('#out').textContent = 'Hello ' + document.querySelector('#name').value">Greet</button>
<p id="out">idle</p>
<a href="http://${out}/link">Elsewhere</a>
<img src="http://${out}/img.png" alt="">
<div style="height: 3000px"></div>
<p id="low">Below the fold</p>
<script>
  console.error("boom");
  fetch("http://${out}/fetch").catch(() => {});
  new WebSocket("ws://${out}/ws");
</script>`,
    );
    writeFileSync(
      join(dir, "server.js"),
      `require("http").createServer((q, s) => s.end(require("fs").readFileSync(__dirname + "/index.html"))).listen(8080);`,
    );
    const started = await startApp("node server.js", dir, "node:24-alpine");
    if ("error" in started) throw new Error(started.error);
    app = started;
    b = appBrowser(app.url, async (name, png) => {
      saved.push({ name, png });
    });
  }, 300_000);

  afterAll(async () => {
    await b?.close();
    await app?.stop();
    outside?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("opens the app at phone width, reads it, and logs console errors", async () => {
    const r = await call("browser_open", { path: "/", width: 375, height: 812 });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^200 at 375×812/);
    expect(r.text).toContain("Tiny app");
    expect(r.text).toContain("console.error: boom");

    const greet = await call("browser_read", { selector: 'role=button[name="Greet"]' });
    expect(greet.text).toContain('button "Greet"');
    expect(greet.text).toContain(
      "Fully visible without scrolling (top of the page, this viewport): yes",
    );
    const low = await call("browser_read", { selector: "#low" });
    expect(low.text).toContain("visible without scrolling (top of the page, this viewport): no");
  });

  it("types and clicks", async () => {
    await call("browser_open", { path: "/", width: 1280, height: 800 });
    await call("browser_type", { selector: "#name", text: "Testy", submit: false });
    await call("browser_click", { selector: 'role=button[name="Greet"]' });
    expect((await call("browser_read", { selector: "#out" })).text).toContain("Hello Testy");
  });

  it("takes a screenshot at desktop width, saved to the ticket and shown to the agent", async () => {
    await call("browser_open", { path: "/", width: 1280, height: 800 });
    const r = await call("browser_screenshot", { name: "Home at 1280", fullPage: false });
    expect(r.content.some((c) => c.type === "image" && c.data)).toBe(true);
    expect(saved.map((s) => s.name)).toEqual(["Home at 1280"]);
    expect(saved[0]!.png.subarray(1, 4).toString()).toBe("PNG");
  });

  it("reaches nothing but the app: subresources, fetch, WebSocket, links and URLs are refused", async () => {
    const opened = await call("browser_open", { path: "/", width: 1280, height: 800 });
    expect(opened.text).toMatch(
      /Blocked \(not the app\): http:\/\/127\.0\.0\.1:\d+\/(img\.png|fetch)/,
    );
    expect(opened.text).toMatch(/Blocked WebSocket/);
    // The navigation is aborted: Chromium shows its error page, and the agent is told why.
    const clicked = await call("browser_click", { selector: "text=Elsewhere" });
    expect(clicked.text).toMatch(/Blocked \(not the app\): http:\/\/127\.0\.0\.1:\d+\/link/);
    for (const path of ["http://evil.example/", "//evil.example/x", "evil"])
      expect((await call("browser_open", { path, width: 1280, height: 800 })).isError).toBe(true);
    expect(hits).toEqual([]);
  });
});
