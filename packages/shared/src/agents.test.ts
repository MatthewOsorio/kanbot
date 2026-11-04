import { describe, expect, it } from "vitest";
import { loadAgent, parseAgentFile } from "./agents";
import { DEFAULT_COLUMNS } from "./workflow";

const file = (front: string, body = "You plan.") => `---\n${front}\n---\n${body}\n`;
const valid = `slug: plan-b
name: Plan B
tagline: Always has a backup plan.
avatar: avatars/plan-b.svg
column: planning
model: claude-opus-5-5
tools: [Read, Grep, Glob]
maxTurns: 30
timeoutMinutes: 15
maxBudgetUsd: 1
verdicts: [success, needs_input, failed]`;

describe("parseAgentFile", () => {
  it("parses frontmatter and prompt", () => {
    const a = parseAgentFile(file(valid));
    expect(a.slug).toBe("plan-b");
    expect(a.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(a.prompt).toBe("You plan.");
  });
  it("handles CRLF files", () => {
    expect(parseAgentFile(file(valid).replaceAll("\n", "\r\n")).name).toBe("Plan B");
  });
  it("rejects a missing frontmatter block, an empty prompt and bad fields", () => {
    expect(() => parseAgentFile("You plan.")).toThrow(/frontmatter/);
    expect(() => parseAgentFile(file(valid, ""))).toThrow(/system prompt/);
    expect(() => parseAgentFile(file(valid.replace("maxTurns: 30", "maxTurns: -1")))).toThrow();
  });
});

describe("loadAgent", () => {
  it("loads every shipped agent file, each serving its default column", () => {
    const shipped = [
      "plan-b",
      "sir-codes-a-lot",
      "nitpick-nancy",
      "testy-mctestface",
      "rubber-duckworth",
    ];
    for (const slug of shipped) {
      const a = loadAgent(slug);
      expect(DEFAULT_COLUMNS.find((c) => c.agentSlug === slug)?.slug).toBe(a?.column);
    }
    expect(loadAgent("sir-codes-a-lot")?.editScope).toBe("worktree");
    expect(loadAgent("nitpick-nancy")?.plugins).toEqual([{ name: "ponytail", level: "off" }]);
  });
  it("returns null for agents not shipped yet", () => {
    expect(loadAgent("captain-ship-it")).toBeNull();
  });
});
