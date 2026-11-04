import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { handle } from "../src/server.ts";

const server = createServer(handle).listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("POST then GET /api/todos", async () => {
  const created = await fetch(`${base}/api/todos`, {
    method: "POST",
    body: JSON.stringify({ title: "Write tests" }),
  });
  assert.equal(created.status, 201);
  const todos = await (await fetch(`${base}/api/todos`)).json();
  assert.equal(todos.at(-1).title, "Write tests");
});

test("POST /api/todos without a title is a 400", async () => {
  const res = await fetch(`${base}/api/todos`, { method: "POST", body: "{}" });
  assert.equal(res.status, 400);
});
