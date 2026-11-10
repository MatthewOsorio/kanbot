import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { blockReason } from "../../../scripts/block-command.mjs";

const hook = resolve(import.meta.dirname, "../../../scripts/block-command.mts");

describe("AI session seatbelt", () => {
  it.each([
    "gh pr merge 12 --squash",
    "cd apps && gh pr merge",
    "gh pr edit 12 --add-label ci-change",
    "gh issue edit 3 --remove-label new-dep",
    "gh label create allow-weakening",
    "gh api repos/o/r/branches/main/protection -X PUT",
    'gh api "repos/o/r/rulesets"',
    "gh api repos/o/r/issues/3/labels -f labels[]=ci-change",
    "gh api repos/o/r/actions/permissions -X PUT",
    "gh api repos/o/r/pulls/3/merge -X PUT",
    "gh api graphql -f query='mutation { mergePullRequest }'",
    "gh secret set X",
    "gh variable set KANBOT_DEPLOY",
    "git push --force origin topic",
    "git push --force-with-lease origin topic",
    "git push -f origin topic",
    "git push -uf origin topic",
    "git push origin +topic",
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    "git commit -m 'x' --no-verify",
    "git push --no-verify origin topic",
  ])("blocks %s", (command) => {
    expect(blockReason(command)).not.toBeNull();
  });

  it.each([
    "gh pr view 12",
    "gh pr create --title x --body 'never run gh pr merge'",
    "gh label list",
    "gh api repos/o/r/pulls/3",
    "gh api graphql -f query='query { viewer { login } }'",
    "git push -u origin topic",
    "git push origin feature/main",
    "git push --follow-tags origin topic",
    "git commit -m 'block --no-verify and git push --force'",
    "pnpm test",
  ])("allows %s", (command) => {
    expect(blockReason(command)).toBeNull();
  });

  const run = (command: string) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });

  it("exits 2 with a reason, which is how Claude Code refuses a tool call", () => {
    const res = run("gh pr merge 12");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("merging a PR");
  });

  it("exits 0 for anything else", () => {
    expect(run("git status").status).toBe(0);
  });
});
