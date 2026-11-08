# Kanbot

Self-hosted Kanban board where AI agents work the columns. The spec is `docs/requirements.md`: build to it, and update it in the same change whenever a decision or behavior changes. Work milestone by milestone (§16) and stop at the end of each for review.

**Status: M1 to M4.5 are done and merged. M5 (ship and deploy) is in progress: phases 1 to 5b are merged, and NNWEB-3 and NNWEB-4 went Backlog to merged on Neural-Noir-Website. Next is 5c (rebases). Kanbot runs in its own WSL distro; a public server is optional (M6). The living report is `docs/m5-report.md` (phase table, progress log): update it as work lands.** What each milestone deliberately left out, and which milestone picks each item up, is in the "Still to build" table in `docs/requirements.md` §16 (the spec's "Where things stand" section summarizes what works today). Read that table before starting a milestone. Anything you defer goes on it too, finished rows come off it, and anything that departs from the spec is edited into the spec and listed under "Changes to the spec" in that milestone's report. What the finished milestones decided is in `docs/history.md`.

## Layout

```
apps/web/            Next.js 16 App Router: board UI + REST API + SSE
  app/api/**/route.ts  thin handlers: parse with zod, call lib/, wrap with route() for {error:{code,message}}
  lib/projects.ts      project + board queries;  lib/tickets.ts  ticket/criteria/comment/activity mutations, overlap check, diff, acceptProposals (epics)
  lib/runs.ts          run history, run log paging, cancel, retry, revise plan
  lib/onboarding.ts    onboarding's GitHub calls: repo list, CI PR, branch protection; the setup page is app/p/[projectId]/setup
  lib/auth.ts          the signed session cookie, OAuth state, originOf(); lib/oauth.ts  GitHub's redirect back;  proxy.ts  localhost + same-origin + session on every route (both unit-tested with Vitest: lib/auth.test.ts, proxy.test.ts)
  app/api/github/**, app/api/auth/**   the GitHub App's two-click setup and Sign in with GitHub;  app/login/  Connect or Sign in
  lib/events.ts        one LISTEN client per process fans out to SSE (publish() itself is in shared)
  components/          board.tsx (dnd-kit) + board-header, board-card; ticket-drawer.tsx (dialog) + drawer-panels, drawer-activity (Live log), drawer-artifacts, drawer-diff; agent-tag.tsx; home.tsx, brand.tsx (Wordmark, SELECT), theme-toggle.tsx, markdown.tsx, ui/ (shadcn, generated: don't hand-edit)
  app/globals.css      design tokens (slate + indigo, status colors bg-running/needs/failed/ok), light and .dark; agent colors come from agent frontmatter
  e2e/                 Playwright; starts its own dev server on :3100 and a replay worker, against database kanbot_test
apps/worker/         Node process (tsx): claims queued runs, runs agents, applies verdicts
  src/main.ts          LISTEN + 5 s poll, claim loop, crash recovery, schedules the nightly cleanup
  src/cleanup.ts       nightlyCleanup: old run_events, worktrees left in Done, unused Kanbot-built images
  src/onboard.ts       onboarding's worker steps: clone + detect, the baseline (§10)
  src/ship.ts          pushAndOpenPr: after Captain Ship-It, push the ticket branch and open or update its PR (FR-43)
  src/watch.ts         the 60 s GitHub poll: CI, reviews, merges and closes move tickets (FR-44 to FR-48)
  src/queue.ts         claimNext (SKIP LOCKED queue), crash recovery, automatic resume
  src/run.ts           executeRun: one run end to end;  src/stall.ts  stuck-agent rules
  src/finish.ts        outcomeOf, finish (verdict → transition, one tx), moveAndStart;  src/results.ts  stores a verdict's artifacts, comments, criteria, links
  src/context.ts       the context bundle (prompt) for a run (branch context, in-flight tickets)
  src/worktree.ts      ensureWorktree (kanbot/<KEY-n>-slug beside the checkout), snapshot, checkAfterRun (post-run checks)
  src/commands.ts      project commands: runChecks (the checks gate), runBaseline, openEnv, commitAs;  src/qa-app.ts  startApp (QA's app on a free PORT)
  src/docker.ts        projectImage (builds the devcontainer's Dockerfile), dockerRun/containerBash (project commands in the project's image)
  src/eval.ts          `pnpm eval:agents`: golden tickets end to end, compared with evals/baseline.json
  src/ci-guards.ts     CI's guards job: fails a PR that weakens the checks (.github/workflows/guards.yml)
  src/runtime/         AgentRuntime interface; sdk.ts (Claude Agent SDK; Kanbot's MCP server with report_result and QA's http_request), browser.ts (QA's headless Chromium tools, fenced to the app's origin), replay.ts (fixtures + record()), redact.ts (secrets out of stored text), fence.ts (permission hook logic, appRequestUrl)
  test/                Vitest against kanbot_test with the replay runtime
packages/shared/     shared by web and worker
  src/schemas.ts       zod API bodies + enums;  src/events.ts  SSE event union + NOTIFY channel
  src/transitions.ts   the transition table as data (afterRun);  src/verdict.ts  report_result schema
  src/agents.ts        agent file loader (server-only export "@kanbot/shared/agents")
  src/repo.ts          git(), .kanbot/project.yml loader, overlap(), branchName() (server-only "@kanbot/shared/repo")
  src/github.ts        the GitHub App's credentials, AES-256-GCM in settings.github_app; gh(), appJwt(), repoToken() (server-only "@kanbot/shared/github"); github-stub.ts for tests
  src/onboarding.ts    onboarding steps, detect(), starterWorkflow(), protection rules ("@kanbot/shared/onboarding")
  src/db/schema.ts     Drizzle schema;  src/db/write.ts publish(), logActivity(), ticketChanged();  src/db/ops.ts startColumnAgent, cancelActiveRun, moveToColumnEnd, projectConfigOf (settings, seeded once from project.yml)
  src/db/testing.ts    prepareTestDatabase(), prepareSampleRepo() for tests, e2e and the eval
  drizzle/             generated SQL migrations (commit them)
agents/              one <slug>.md per agent (YAML frontmatter + system prompt) and avatars/: plan-b, sir-codes-a-lot, nitpick-nancy, testy-mctestface, captain-ship-it, rubber-duckworth, archie-the-archivist
plugins/             vendored, pinned plugins (each has a VENDORED.md); agents list plugins in frontmatter
  ponytail/            Ponytail;  security-audit/  Cloudflare's security-audit skill, reshaped into one skill for Nancy
fixtures/runs/       replay scripts: <agent>/<scenario>[.<n>].json; a ticket label `replay:<scenario>` picks one, n = the agent's nth run
fixtures/sample-repo/ zero-dependency todo app (with .kanbot/project.yml) copied into fresh git repos by prepareSampleRepo()
fixtures/golden/     the golden tickets for `pnpm eval:agents`
docs/requirements.md the spec;  docs/deploy.md  running Kanbot: A) its own WSL distro, B) a server (rootless Docker, .env, deploys, backups)
Dockerfile           --target web / --target worker (worker adds git + docker CLI);  Caddyfile  HTTPS in front of web
docker-compose.yml   db (local default); profile app adds migrate, web (127.0.0.1), worker (host network, Docker socket); profile public adds caddy
```

## Commands (repo root)

```
docker compose up -d db     Postgres 16 on 127.0.0.1:5432 (cp .env.example .env first)
docker compose up -d --build   with COMPOSE_PROFILES=app in .env: the whole stack (docs/deploy.md); never the public profile locally (caddy publishes 80/443)
pnpm db:migrate             apply migrations;  pnpm db:generate --name <x>  after editing db/schema.ts
pnpm dev                    web on http://127.0.0.1:3000 + worker (dev:web / dev:worker run one)
pnpm typecheck | lint | test | test:e2e | build | format | format:check
pnpm eval:agents            golden tickets with REAL agents (costs money; ask first). --baseline saves evals/baseline.json if every ticket reached QA
```

The worker uses the real Claude Agent SDK unless `KANBOT_RUNTIME=replay` (needs `ANTHROPIC_API_KEY` in `.env`). Tests and CI only ever use replay. A real run costs money: Plan B was about $0.15–0.45 per plan in the M2 smoke test. `KANBOT_RECORD=1` saves real runs as replay scripts (see `.env.example`); `KANBOT_RUNTIME=replay pnpm eval:agents` checks the eval script for free.

Project commands run in the project's image (`docker run`; from the repo's devcontainer, project.yml or Settings "Image") when it has one, else in `KANBOT_DEFAULT_IMAGE` (set by compose: project code never runs in the worker's container, which holds the Docker socket), else (`pnpm dev`) on the host toolchain; the Docker-backed worker tests skip when Docker isn't running. Build agents work in worktrees at `<repo>.kanbot-worktrees/<KEY-n>`, never in the checkout. A project's commands, test globs, hotspots, bounce limit and concurrency live in the database (Settings page), seeded once from `.kanbot/project.yml` on its default branch. The permission hook (`fence.ts`) is the security boundary for agent tools: the SDK auto-approves read-only shell commands in every mode, so never rely on `allowedTools` alone.

`pnpm test:e2e` can run while `pnpm dev` is running: it uses `NEXT_DIST_DIR=.next-e2e`, its own database and its own replay worker. Worker tests (`pnpm test`) share `kanbot_test` and cancel any leftover active runs there first.

If `pnpm dev` returns 500 with a Turbopack panic about `globals.css` / exit code `0xc0000142`, delete `apps/web/.next`. This was seen on Windows after a `pnpm build` and killed dev servers. On Windows, stopping `pnpm dev` from a parent shell can leave the `next` node process alive on the port. Kill it by PID (`netstat -ano | findstr :3000`). `pnpm dev` refuses to start a second Next dev server for `apps/web`; if one is already running, start just the worker with `pnpm dev:worker`. In Git Bash, the pnpm shim can fail; put `$APPDATA/npm/node_modules/pnpm` on PATH. MSYS also mangles backslashes in `node -e` arguments, so use forward slashes in Windows paths there.

## Conventions

- TypeScript strict, everywhere. No Python anywhere (scripts and tooling included).
- IDs are UUIDv7 (`uuidv7()`), timestamps `timestamptz`, enums are `pgEnum`s built from the arrays in `schemas.ts`.
- Ticket order is a `fractional-indexing` key. Always `ORDER BY position COLLATE "C"` in SQL and compare with `<` (never `localeCompare`) in JS.
- Every ticket or run mutation writes an `activity` row and calls `publish()` in the same transaction (agents are the actor for worker writes). Clients refetch on every event (no client-side patching), except `run.event`, which carries ids only (NOTIFY's 8 KB cap); the Live tab pages `/api/runs/:id/events?after=seq`.
- Web and worker never call each other: the web app inserts `queued` runs, the worker claims them; cancels travel as a `run.finished` event.
- Validate every API body and `[id]` param at the boundary (`parseBody`, `idParam`). Errors are `{error: {code, message}}`.
- New agent behavior goes in `transitions.ts` (data) and gets a unit test; worker paths get a replay scenario in `fixtures/runs` and a test in `apps/worker/test`. Replay patches apply to `fixtures/sample-repo`, which is kept LF (`.gitattributes`).
- Each agent prompt change is checked with `pnpm eval:agents` before merging (§8), with the owner's OK for the spend.
- CI's `guards` job fails a PR that weakens the checks (new skips or `ts-ignore`s, fewer tests or assertions, edits to CI, lint, security files, install settings or existing replay fixtures, new dependencies, destructive migrations, an agent change without a baseline from a real run on those exact files). Only the owner adds its override labels (`allow-weakening`, `allow-test-removal`, `ci-change`, `eval-skip`, `new-dep`, `destructive-migration`): stop and ask, don't add one yourself. `.claude/hooks/block-command.mts` refuses merges, label changes, repo-rule edits and force pushes in AI sessions: if it blocks you, stop and ask, don't work around it. `repo-rules.test.ts` checks that paths in this file exist and every worker module is listed. Migrations are append-only. Tests can't reach a real service; use the replay runtime or `github-stub.ts`.
- Any change the owner can see in the UI is checked in a real browser before it's called done. Write a throwaway Playwright script (scratchpad, not `e2e/`) against `pnpm dev:web` on its own port and database plus a `KANBOT_RUNTIME=replay` worker. Screenshot each step and look at the screenshots. Report pass/fail with the screenshot paths. This is free, so no spend OK is needed. Promote a check to `e2e/` only when it's worth keeping.
- A known-limited shortcut gets a `shortcut: <limit>, <when to upgrade>` comment.
- One `.env` at the repo root; `.env.example` lists every variable. Never commit secrets.
- Dependencies: pnpm 12 enforces a minimum release age. Pick a mature version rather than adding `minimumReleaseAgeExclude` entries.
- Every route needs the owner's session (Sign in with GitHub, `proxy.ts`), and the app still binds to 127.0.0.1 and answers only on localhost: don't expose it (a public server is M6). Set `KANBOT_SESSION_SECRET` and `KANBOT_ENCRYPTION_KEY` in `.env`. e2e and browser checks never switch auth off: `e2e/global-setup.ts` stores a fake App and signs a session with test secrets (`playwright.config.ts`), and every spec runs with that cookie.
