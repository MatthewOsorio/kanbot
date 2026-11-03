# Kanbot

Self-hosted Kanban board where AI agents work the columns. The spec is `docs/requirements.md`: build to it, and update it in the same change whenever a decision or behavior changes. Work milestone by milestone (§16) and stop at the end of each for review.

**Status: M2 (orchestrator and Plan B) is done; M1 (board) before it.** What each milestone deliberately left out, and which milestone picks each item up, is listed under "Deferred from M1" and "Deferred from M2" in `docs/requirements.md` §16. Read those lists before starting a milestone. Anything you defer goes on them too, and anything that departs from the spec is edited into the spec and listed under "Changes to the spec" in that milestone's report. What each milestone built, and why, is in `docs/m1-report.md` and `docs/m2-report.md`.

## Layout

```
apps/web/            Next.js 16 App Router: board UI + REST API + SSE
  app/api/**/route.ts  thin handlers: parse with zod, call lib/, wrap with route() for {error:{code,message}}
  lib/projects.ts      project + board queries;  lib/tickets.ts  ticket/criteria/comment/activity mutations
  lib/runs.ts          run history, run log paging, cancel, retry, revise plan
  lib/events.ts        one LISTEN client per process fans out to SSE (publish() itself is in shared)
  components/          board.tsx (dnd-kit), ticket-drawer.tsx (tabs, Live log), markdown.tsx, ui/ (shadcn, generated: don't hand-edit)
  e2e/                 Playwright; starts its own dev server on :3100 and a replay worker, against database kanbot_test
apps/worker/         Node process (tsx): claims queued runs, runs agents, applies verdicts
  src/main.ts          LISTEN + 5 s poll, claim loop, crash recovery
  src/run.ts           claimNext (SKIP LOCKED queue), executeRun, outcomeOf, finish (verdict → transition, one tx)
  src/context.ts       the context bundle (prompt) for a run
  src/runtime/         AgentRuntime interface; sdk.ts (Claude Agent SDK), replay.ts (fixtures, for tests)
  test/                Vitest against kanbot_test with the replay runtime
packages/shared/     shared by web and worker
  src/schemas.ts       zod API bodies + enums;  src/events.ts  SSE event union + NOTIFY channel
  src/transitions.ts   the transition table as data (afterRun);  src/verdict.ts  report_result schema
  src/agents.ts        agent file loader (server-only export "@kanbot/shared/agents")
  src/db/schema.ts     Drizzle schema;  src/db/write.ts publish(), logActivity();  src/db/ops.ts startColumnAgent, cancelActiveRun, moveToColumnEnd
  src/db/testing.ts    prepareTestDatabase() for e2e and worker tests
  drizzle/             generated SQL migrations (commit them)
agents/              one <slug>.md per agent (YAML frontmatter + system prompt) and avatars/. Only plan-b.md so far.
fixtures/runs/       replay scripts: <agent>/<scenario>.json; a ticket label `replay:<scenario>` picks one
docs/requirements.md the spec
```

## Commands (repo root)

```
docker compose up -d db     Postgres 16 on 127.0.0.1:5432 (cp .env.example .env first)
pnpm db:migrate             apply migrations;  pnpm db:generate --name <x>  after editing db/schema.ts
pnpm dev                    web on http://127.0.0.1:3000 + worker (dev:web / dev:worker run one)
pnpm typecheck | lint | test | test:e2e | build | format
```

The worker uses the real Claude Agent SDK unless `KANBOT_RUNTIME=replay` (needs `ANTHROPIC_API_KEY` in `.env`). Tests and CI only ever use replay. A real run costs money: Plan B was about $0.15–0.45 per plan in the M2 smoke test.

`pnpm test:e2e` can run while `pnpm dev` is running: it uses `NEXT_DIST_DIR=.next-e2e`, its own database and its own replay worker. Worker tests (`pnpm test`) share `kanbot_test` and cancel any leftover active runs there first.

If `pnpm dev` returns 500 with a Turbopack panic about `globals.css` / exit code `0xc0000142`, delete `apps/web/.next`. This was seen on Windows after a `pnpm build` and killed dev servers. On Windows, stopping `pnpm dev` from a parent shell can leave the `next` node process alive on the port. Kill it by PID (`netstat -ano | findstr :3000`). `pnpm dev` refuses to start a second Next dev server for `apps/web`; if one is already running, start just the worker with `pnpm dev:worker`. In Git Bash, the pnpm shim can fail; put `$APPDATA/npm/node_modules/pnpm` on PATH. MSYS also mangles backslashes in `node -e` arguments, so use forward slashes in Windows paths there.

## Conventions

- TypeScript strict, everywhere. No Python anywhere (scripts and tooling included).
- IDs are UUIDv7 (`uuidv7()`), timestamps `timestamptz`, enums are `pgEnum`s built from the arrays in `schemas.ts`.
- Ticket order is a `fractional-indexing` key. Always `ORDER BY position COLLATE "C"` in SQL and compare with `<` (never `localeCompare`) in JS.
- Every ticket or run mutation writes an `activity` row and calls `publish()` in the same transaction (agents are the actor for worker writes). Clients refetch on every event (no client-side patching), except `run.event`, which carries ids only (NOTIFY's 8 KB cap); the Live tab pages `/api/runs/:id/events?after=seq`.
- Web and worker never call each other: the web app inserts `queued` runs, the worker claims them; cancels travel as a `run.finished` event.
- Validate every API body and `[id]` param at the boundary (`parseBody`, `idParam`). Errors are `{error: {code, message}}`.
- New agent behavior goes in `transitions.ts` (data) and gets a unit test; worker paths get a replay scenario in `fixtures/runs` and a test in `apps/worker/test`.
- A known-limited shortcut gets a `shortcut: <limit>, <when to upgrade>` comment.
- One `.env` at the repo root; `.env.example` lists every variable. Never commit secrets.
- Dependencies: pnpm 12 enforces a minimum release age. Pick a mature version rather than adding `minimumReleaseAgeExclude` entries.
- The app has no auth until M4 and binds to 127.0.0.1. Don't expose it.
