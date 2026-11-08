// Onboarding a GitHub repo (requirements §10): the steps' state, command detection, the starter CI
// workflow and the branch-protection rules. Pure: browser-safe, no I/O.
import { stringify } from "yaml";
import { z } from "zod";

export const onboardingSteps = [
  "clone",
  "commands",
  "baseline",
  "ci",
  "protection",
  "ready",
] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];

/**
 * `projects.onboarding`. The worker does `clone` and `baseline` while `queued`/`running`; every other
 * step (and those two once done) is `waiting` for the owner. Null for projects without a GitHub repo.
 */
export type Onboarding = {
  step: OnboardingStep;
  state: "queued" | "running" | "waiting" | "failed";
  error?: string;
  /** The starter workflow PR, once opened (step `ci`). */
  ciPrUrl?: string;
  /** The owner chose to run agents without branch protection (step `protection`). */
  override?: boolean;
};

/** `projects.baseline`: install/build/lint/test on the default branch at onboarding (step 5). */
export type Baseline = Record<string, { command: string; ok: boolean; output: string }>;

/** The baseline commands that failed: the checks gate skips them, agents are told (owner's choice). */
export const baselineFailures = (b: Baseline | null | undefined) =>
  Object.values(b ?? {})
    .filter((r) => !r.ok)
    .map((r) => r.command);

type Commands = { install?: string; build?: string; test?: string; lint?: string; start?: string };
type Detected = { commands: Commands; testGlobs: string[]; image?: string };

/** QA runs the app (§4, owner's choice): a project needs a start command before QA can start. */
export const qaRunnable = (c: { commands: Commands }) => !!c.commands.start?.trim();

export const QA_SETUP_MESSAGE = "QA needs the app running: set a start command in Settings";

/**
 * Proposes commands, test globs and an image from the default branch's file list and a few files'
 * contents (step 4). Only what the files show; the owner confirms or edits.
 * shortcut: Node, Python and Go only, root of the repo only; add ecosystems when a project needs one.
 */
export function detect(files: string[], read: (file: string) => string): Detected {
  const has = (f: string) => files.includes(f);
  if (has("package.json")) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts =
        (JSON.parse(read("package.json")) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      // unreadable package.json: install only
    }
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const install = {
      pnpm: "pnpm install --frozen-lockfile",
      yarn: "yarn install --frozen-lockfile",
      npm: has("package-lock.json") ? "npm ci" : "npm install",
    }[pm];
    const script = (s: string) => (typeof scripts[s] === "string" ? `${pm} run ${s}` : undefined);
    return {
      commands: {
        install,
        build: script("build"),
        lint: script("lint"),
        test: script("test"),
        // QA runs the app as a person would; the worker finds whatever port it listens on (§4).
        start: script("start") ?? script("dev"),
      },
      testGlobs: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
      image: "node:24-bookworm",
    };
  }
  if (has("go.mod"))
    return {
      commands: {
        install: "go mod download",
        build: "go build ./...",
        lint: "go vet ./...",
        test: "go test ./...",
      },
      testGlobs: ["**/*_test.go"],
      image: "golang:1.23-bookworm",
    };
  if (files.some((f) => f.endsWith(".py"))) {
    const deps = ["requirements.txt", "pyproject.toml"].filter(has).map(read).join("\n");
    const tests = files.some((f) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f));
    return {
      commands: {
        // Each command is its own container (§7), so packages go to HOME (the shared cache volume).
        install: has("requirements.txt")
          ? "pip install --user -r requirements.txt"
          : has("pyproject.toml")
            ? "pip install --user -e ."
            : undefined,
        build: "python -m compileall -q .",
        test: tests
          ? /pytest/i.test(deps)
            ? "python -m pytest"
            : "python -m unittest discover"
          : undefined,
      },
      testGlobs: ["**/test_*.py", "**/*_test.py", "tests/**"],
      image: "python:3.12-bookworm",
    };
  }
  return { commands: {}, testGlobs: [] };
}

/** Files whose keys onboarding proposes as the project's env vars (step 4); the first one found wins. */
export const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template"];

/** The variable names in a dotenv file: `NAME=…` lines, `export NAME=…` too; comments skipped. */
export const envNames = (text: string) => [
  ...new Set(
    text
      .split("\n")
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter((n): n is string => !!n),
  ),
];

/** The starter workflow Kanbot offers as a PR (step 6): one job, `ci`, in the project's image. */
export const STARTER_WORKFLOW_PATH = ".github/workflows/kanbot-ci.yml";
export const STARTER_CHECK = "ci";
/** `env`: the project's env var names, read from the repo's Actions secrets (the owner adds them there). */
export function starterWorkflow(commands: Commands, image?: string, env: string[] = []) {
  const steps = (["install", "build", "lint", "test"] as const)
    .filter((k) => commands[k])
    .map((k) => ({ name: k, run: commands[k]! }));
  return stringify({
    name: "Kanbot CI",
    on: { push: { branches: ["kanbot/**"] }, pull_request: null },
    jobs: {
      [STARTER_CHECK]: {
        "runs-on": "ubuntu-latest",
        ...(image && { container: image }),
        ...(env.length > 0 && {
          env: Object.fromEntries(env.map((n) => [n, `\${{ secrets.${n} }}`])),
        }),
        steps: [{ uses: "actions/checkout@v4" }, ...steps],
      },
    },
  }).replace("pull_request: null", "pull_request:");
}

/** GitHub's branch protection, the parts §10 cares about. */
export const branchProtection = z.object({
  required_status_checks: z.object({ strict: z.boolean() }).nullish(),
  required_pull_request_reviews: z
    .object({ required_approving_review_count: z.number().default(0) })
    .nullish(),
  allow_force_pushes: z.object({ enabled: z.boolean() }).nullish(),
  allow_deletions: z.object({ enabled: z.boolean() }).nullish(),
});

/** Which of §10's rules the default branch lacks; empty = protected. Null protection = all of them. */
export function missingRules(p: z.infer<typeof branchProtection> | null): string[] {
  return [
    (p?.required_pull_request_reviews?.required_approving_review_count ?? 0) < 1
      ? "a pull request with 1 approving review"
      : null,
    !p?.required_status_checks?.strict ? "status checks passing on an up-to-date branch" : null,
    !p || p.allow_force_pushes?.enabled ? "no force-pushes" : null,
    !p || p.allow_deletions?.enabled ? "no deletion" : null,
  ].filter((x): x is string => x !== null);
}

/** The body of `PUT /repos/{o}/{r}/branches/{b}/protection` (owner's choice: admins included). */
export const protectionRules = (checks: string[]) => ({
  required_status_checks: { strict: true, contexts: checks },
  enforce_admins: true,
  required_pull_request_reviews: { required_approving_review_count: 1 },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
});
