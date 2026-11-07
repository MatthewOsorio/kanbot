import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * The permission fence every agent tool call passes through (requirements §14), kept pure so it is
 * unit-tested without the SDK. Returns a denial reason, or null to let the SDK's own rules decide.
 */
export type Fence = {
  cwd: string;
  /** Frontmatter `tools` after placeholder expansion, e.g. "Read", "Bash(git diff:*)". */
  tools: readonly string[];
  /** Repo-relative path → may Edit/Write touch it? Absent = any path inside cwd. */
  canEdit?: (rel: string) => boolean;
};

const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;
/** QA's HTTP tool into the running app (§4, sdk.ts). */
export const HTTP_TOOL = "mcp__kanbot__http_request";
const PATTERN_FIELDS = ["pattern", "glob"] as const; // path globs: Glob's pattern, Grep's glob filter
export const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const META_REFUSAL =
  "Run one plain command: no pipes, chaining, redirects, substitutions, backslashes or newlines";

/**
 * Splits a command into the argv the shell would pass, understanding quotes only. Anything else that
 * chains, redirects, substitutes or escapes is refused, so the result is exactly what runs.
 * Inside single quotes everything is literal; inside double quotes only `$`, backtick and `\` act.
 */
function argv(cmd: string): string[] | string {
  const out: string[] = [];
  let cur: string | null = null;
  let quote: string | null = null;
  for (const ch of cmd) {
    if (ch === "\n" || ch === "\r") return META_REFUSAL;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && /[$`\\]/.test(ch)) return META_REFUSAL;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur ??= "";
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else if (/[;&|<>`$\\()]/.test(ch)) return META_REFUSAL;
    else cur = (cur ?? "") + ch;
  }
  if (quote) return "Unterminated quote";
  if (cur !== null) out.push(cur);
  return out;
}

/** A `git commit` message argument: free text, so its words aren't paths (found in the M3 golden run). */
const isMessage = (args: string[], i: number) =>
  args[0] === "git" &&
  args[1] === "commit" &&
  (args[i - 1] === "-m" || args[i - 1] === "--message" || /^(-m.|--message=)/.test(args[i]!));
// git flags that read or write outside the repository whatever their argument looks like.
const BAD_FLAGS =
  /^(--output|--no-index|--git-dir|--work-tree|--exec-path|-C|-c|--config-env)(=|$)/;

/** Resolves symlinks, also for a path that doesn't exist yet (its nearest existing parent). */
function real(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    tail.unshift(relative(up, head));
    head = up;
  }
  return resolve(realpathSync.native(head), ...tail);
}

/** Repo-relative path, or null when `p` resolves outside `cwd`. */
export function insideCwd(cwd: string, p: string): string | null {
  const rel = relative(real(cwd), real(resolve(cwd, p)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
    ? rel.replaceAll("\\", "/")
    : null;
}

// Each brace alternative counts on its own: globs and the shell expand `{..,src}` to `..` (found in the M3 hardening pass).
const escapes = (s: string) =>
  s
    .split(/[{,]/)
    .some(
      (p) =>
        isAbsolute(p) ||
        /^[A-Za-z]:/.test(p) ||
        p.startsWith("~") ||
        p.split(/[\\/}]/).includes(".."),
    );

/** `Bash(git diff:*)` / `Bash(git diff *)` = prefix; `Bash(git status)` = exact. */
function bashAllowed(command: string, tools: readonly string[]) {
  const cmd = command.trim().replace(/\s+/g, " ");
  return tools.some((t) => {
    const m = /^Bash\((.+)\)$/.exec(t);
    if (!m) return false;
    const rule = m[1]!.trim();
    const prefix = /(:\*| \*)$/.test(rule) ? rule.slice(0, -2) : null;
    return prefix === null ? cmd === rule : cmd === prefix || cmd.startsWith(`${prefix} `);
  });
}

export function checkToolCall(
  name: string,
  input: Record<string, unknown>,
  f: Fence,
): string | null {
  const names = new Set(f.tools.map((t) => t.replace(/\(.*$/, "")));
  if (!names.has(name)) return `${name} is not in this agent's tools`;
  // Its `path` is a URL path on the QA app, not a file: appRequestUrl fences it (found in the M5 eval).
  if (name === HTTP_TOOL) return null;

  for (const k of PATH_FIELDS) {
    const v = input[k];
    if (typeof v !== "string" || !v) continue;
    const rel = v.startsWith("~") ? null : insideCwd(f.cwd, v); // the tools expand ~ to the home folder
    if (rel === null) return `${v} is outside this run's working directory`;
    // A worktree's .git file names its repository: rewritten, commits land on the default branch.
    // Lowercased: Windows and macOS file systems treat .GIT as .git.
    if (EDIT_TOOLS.has(name) && /^\.git(\/|$)/.test(rel.toLowerCase()))
      return `${rel} is git's own data; agents may not edit it`;
    if (EDIT_TOOLS.has(name) && f.canEdit && !f.canEdit(rel))
      return `${rel} is outside the files this agent may edit`;
  }
  for (const k of PATTERN_FIELDS) {
    if (k === "pattern" && name !== "Glob") continue; // Grep's `pattern` is a regex, not a path
    const v = input[k];
    if (typeof v === "string" && escapes(v))
      return `${k} "${v}" reaches outside the working directory`;
  }

  if (name === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    const args = argv(cmd);
    if (typeof args === "string") return args;
    const bad = args.find(
      (t, i) => !isMessage(args, i) && (BAD_FLAGS.test(t) || t.split("=").some(escapes)),
    );
    if (bad) return `"${bad}" would reach outside the working directory`;
    if (!bashAllowed(cmd, f.tools)) return `"${cmd}" is not in this agent's command allowlist`;
  }
  return null;
}

/**
 * The QA app's `http_request` tool (§4) reaches only the app the worker started: `path` must be a path on
 * `base` (no other host, scheme or port). Returns the URL to fetch, or a refusal.
 */
export function appRequestUrl(base: string, path: string): URL | string {
  if (!path.startsWith("/") || path.startsWith("//"))
    return `Give a path starting with one "/" (e.g. /api/todos), not a URL`;
  const url = new URL(path, base);
  return url.origin === new URL(base).origin ? url : `${path} is not on the app at ${base}`;
}
