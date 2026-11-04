import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TodoStore } from "./todos.ts";

const store = new TodoStore();

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = Number(url.pathname.match(/^\/api\/todos\/(\d+)$/)?.[1]);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(await readFile(new URL("../public/index.html", import.meta.url)));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/todos") return send(res, 200, store.list());
  if (req.method === "POST" && url.pathname === "/api/todos") {
    const { title } = await readJson(req);
    if (typeof title !== "string" || !title.trim())
      return send(res, 400, { error: "title is required" });
    return send(res, 201, store.add(title));
  }
  if (req.method === "PATCH" && id) {
    const todo = store.toggle(id);
    return todo ? send(res, 200, todo) : send(res, 404, { error: "not found" });
  }
  if (req.method === "DELETE" && id) {
    return store.remove(id) ? send(res, 204) : send(res, 404, { error: "not found" });
  }
  send(res, 404, { error: "not found" });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  createServer(handle).listen(port, () => console.log(`http://localhost:${port}`));
}
