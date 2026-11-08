// PreToolUse seatbelt for AI sessions: refuses the commands that are the owner's to run (requirements §15).
// shortcut: reads the command as text, so a script or alias gets past it and the token still has admin rights; upgrade to a write-only machine account if an agent ever works around it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ON_UNQUOTED: [RegExp, string][] = [
  [/\bgh\s+pr\s+merge\b/, "merging a PR"],
  [/\bgh\s+(pr|issue)\s+edit\b[^\n;|&]*--(add|remove)-label\b/, "changing override labels"],
  [/\bgh\s+label\s+(create|edit|delete|clone)\b/, "changing override labels"],
  [/\bgh\s+(secret|variable)\b/, "changing repo secrets or variables"],
  [/\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*\s(--force\S*|-[a-zA-Z]*f\b|\+\S+)/, "force-pushing"],
  [/\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*\s(\S+:)?(refs\/heads\/)?main(\s|$)/m, "pushing to main"],
  [/\bgit\s[^\n;|&]*--no-verify\b/, "skipping git hooks"],
];
// URLs are often quoted, so these read the raw command.
const ON_RAW: [RegExp, string][] = [
  [
    /\bgh\s+api\b[^\n;|&]*(protection|rulesets|labels|actions\/permissions|\/merge\b)/,
    "changing repo rules through the API",
  ],
  [/\bgh\s+api\s+graphql\b[\s\S]*\bmutation\b/, "changing the repo through GraphQL"],
];

export function blockReason(command: string): string | null {
  const unquoted = command.replace(/"[^"]*"|'[^']*'/g, "");
  const hit =
    ON_UNQUOTED.find(([rule]) => rule.test(unquoted)) ??
    ON_RAW.find(([rule]) => rule.test(command));
  return hit ? hit[1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, "utf8")) as { tool_input?: { command?: string } };
  const reason = blockReason(input.tool_input?.command ?? "");
  if (reason) {
    console.error(`Blocked: ${reason} is the owner's to do. Stop and ask them.`);
    process.exit(2);
  }
}
