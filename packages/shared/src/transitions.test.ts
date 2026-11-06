import { describe, expect, it } from "vitest";
import { afterRun, BOUNCE_LIMIT } from "./transitions";

const stay = (flag: string) => ({ to: null, flag, bounce: false });

describe("afterRun", () => {
  it("keeps a planned ticket in Planning, flagged plan_ready", () => {
    expect(afterRun("planning", "succeeded")).toEqual(stay("plan_ready"));
  });
  it.each(["failed", "timed_out", "budget_exceeded"] as const)("sends %s to Blocked", (o) => {
    expect(afterRun("planning", o)).toEqual({ to: "blocked", flag: "failed", bounce: false });
  });
  it("sends needs_input to Blocked flagged needs_input", () => {
    expect(afterRun("planning", "awaiting_input")).toEqual({
      to: "blocked",
      flag: "needs_input",
      bounce: false,
    });
  });
  it("keeps interrupted and cancelled runs in place", () => {
    expect(afterRun("planning", "interrupted")).toEqual(stay("failed"));
    expect(afterRun("planning", "cancelled")).toEqual(stay("none"));
  });
  it("keeps a ticket in Blocked, waiting for the owner, however Duckworth's run ends", () => {
    for (const o of ["succeeded", "failed", "timed_out", "budget_exceeded"] as const)
      expect(afterRun("blocked", o)).toEqual(stay("needs_input"));
    expect(afterRun("blocked", "interrupted")).toEqual(stay("failed"));
  });
  it("stays put for columns with no rule", () => {
    expect(afterRun("ship", "succeeded")).toEqual(stay("none"));
  });
});

describe("build loop", () => {
  it("moves a finished build to Code Review, and an approved review to QA", () => {
    expect(afterRun("in_progress", "succeeded", { verdict: "success" })).toEqual({
      to: "code_review",
      flag: "none",
      bounce: false,
    });
    expect(afterRun("code_review", "succeeded", { verdict: "success" })).toEqual({
      to: "qa",
      flag: "none",
      bounce: false,
    });
  });
  it("waits for approval after QA passes", () => {
    expect(afterRun("qa", "succeeded", { verdict: "success" })).toEqual(stay("awaiting_approval"));
  });
  it("bounces review changes and QA failures back to In Progress", () => {
    const back = { to: "in_progress", flag: "none", bounce: true };
    expect(afterRun("code_review", "changes_requested", { verdict: "changes_requested" })).toEqual(
      back,
    );
    expect(afterRun("qa", "failed", { verdict: "failed" })).toEqual(back);
  });
  it("reruns Sir Codes-a-Lot in place when the checks gate fails, until the bounce limit", () => {
    const v = { verdict: "success" as const };
    expect(afterRun("in_progress", "changes_requested", v)).toEqual({
      to: null,
      flag: "none",
      bounce: true,
      rerun: true,
    });
    expect(
      afterRun("in_progress", "changes_requested", { ...v, bounces: BOUNCE_LIMIT }),
    ).toMatchObject({ to: "blocked", reason: "bounce_limit" });
  });
  it("sends a QA run that failed without reporting to Blocked, not back to In Progress", () => {
    expect(afterRun("qa", "failed")).toEqual({ to: "blocked", flag: "failed", bounce: false });
  });
  it("sends a failed build or review run to Blocked", () => {
    expect(afterRun("in_progress", "failed", { verdict: "failed" }).to).toBe("blocked");
    expect(afterRun("code_review", "failed", { verdict: "failed" }).to).toBe("blocked");
  });
  it("blocks the bounce after the limit", () => {
    const v = { verdict: "changes_requested" as const };
    expect(
      afterRun("code_review", "changes_requested", { ...v, bounces: BOUNCE_LIMIT - 1 }).to,
    ).toBe("in_progress");
    expect(afterRun("code_review", "changes_requested", { ...v, bounces: BOUNCE_LIMIT })).toEqual({
      to: "blocked",
      flag: "failed",
      bounce: false,
      reason: "bounce_limit",
    });
    expect(afterRun("qa", "failed", { verdict: "failed", bounces: BOUNCE_LIMIT }).reason).toBe(
      "bounce_limit",
    );
  });
  it("takes the bounce limit from the project", () => {
    const v = { verdict: "changes_requested" as const, bounces: 1 };
    expect(afterRun("code_review", "changes_requested", { ...v, bounceLimit: 2 }).to).toBe(
      "in_progress",
    );
    expect(afterRun("code_review", "changes_requested", { ...v, bounceLimit: 1 }).reason).toBe(
      "bounce_limit",
    );
  });
  it("keeps a finished ticket in Done however Archie's run ends", () => {
    expect(afterRun("done", "succeeded")).toEqual({ to: null, flag: "none", bounce: false });
    for (const o of ["failed", "timed_out", "budget_exceeded", "awaiting_input"] as const)
      expect(afterRun("done", o)).toEqual({ to: null, flag: "failed", bounce: false });
  });
});
