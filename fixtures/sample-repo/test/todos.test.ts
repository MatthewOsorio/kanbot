import assert from "node:assert/strict";
import { test } from "node:test";
import { TodoStore } from "../src/todos.ts";

test("add trims the title and starts open", () => {
  const store = new TodoStore();
  assert.deepEqual(store.add("  Buy milk "), { id: 1, title: "Buy milk", done: false });
});

test("add rejects an empty title", () => {
  assert.throws(() => new TodoStore().add("   "), /required/);
});

test("toggle flips done", () => {
  const store = new TodoStore();
  const { id } = store.add("Walk the dog");
  assert.equal(store.toggle(id)?.done, true);
  assert.equal(store.toggle(id)?.done, false);
});

test("remove deletes the todo", () => {
  const store = new TodoStore();
  const { id } = store.add("Call mom");
  assert.equal(store.remove(id), true);
  assert.deepEqual(store.list(), []);
});
