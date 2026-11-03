import { describe, expect, it } from "vitest";
import { afterRun } from "./transitions";

describe("afterRun", () => {
  it("keeps a planned ticket in Planning, flagged plan_ready", () => {
    expect(afterRun("planning", "succeeded")).toEqual({ to: null, flag: "plan_ready" });
  });
  it.each(["failed", "timed_out", "budget_exceeded"] as const)("sends %s to Blocked", (o) => {
    expect(afterRun("planning", o)).toEqual({ to: "blocked", flag: "failed" });
  });
  it("sends needs_input to Blocked flagged needs_input", () => {
    expect(afterRun("planning", "awaiting_input")).toEqual({ to: "blocked", flag: "needs_input" });
  });
  it("keeps interrupted and cancelled runs in place", () => {
    expect(afterRun("planning", "interrupted")).toEqual({ to: null, flag: "failed" });
    expect(afterRun("planning", "cancelled")).toEqual({ to: null, flag: "none" });
  });
  it("does not move a ticket already in Blocked", () => {
    expect(afterRun("blocked", "failed")).toEqual({ to: null, flag: "failed" });
  });
  it("stays put for outcomes M2 has no rule for", () => {
    expect(afterRun("in_progress", "succeeded")).toEqual({ to: null, flag: "none" });
  });
});
