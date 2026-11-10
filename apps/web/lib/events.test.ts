import type { EventEnvelope } from "@kanbot/shared";
import { expect, it, vi } from "vitest";
import { fanOut, subscribe } from "./events";

// The module keeps its LISTEN connection here; set it so no test touches a database.
const g = globalThis as { kanbotListen?: Promise<void> };
const event: EventEnvelope = {
  id: "1",
  projectId: "*",
  event: { type: "settings.updated", paused: false },
};

it("still reaches every open stream when one listener's stream has closed", async () => {
  g.kanbotListen = Promise.resolve();
  const dead = vi.fn(() => {
    throw new TypeError("Invalid state: Controller is already closed");
  });
  const live = vi.fn();
  const offDead = await subscribe(dead);
  const offLive = await subscribe(live);
  fanOut(event);
  fanOut(event);
  expect(live).toHaveBeenCalledTimes(2);
  expect(dead).toHaveBeenCalledTimes(1); // dropped after it threw
  offDead();
  offLive();
});

it("leaves no listener behind when LISTEN can't start", async () => {
  g.kanbotListen = Promise.reject(new Error("database down"));
  g.kanbotListen.catch(() => {});
  const listener = vi.fn();
  await expect(subscribe(listener)).rejects.toThrow("database down");
  g.kanbotListen = undefined;
  fanOut(event);
  expect(listener).not.toHaveBeenCalled();
});
