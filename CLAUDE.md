# Kanbot

Self-hosted Kanban board where AI agents work the columns. The spec is `docs/requirements.md`: build to it, and update it in the same change whenever a decision or behavior changes. Work milestone by milestone (§16) and stop at the end of each for review.

**Status: M1 (board without agents) is done.** What M1 deliberately left out, and which milestone picks each item up, is listed under "Deferred from M1" in `docs/requirements.md` §16. Read that list before starting a milestone. Anything you defer goes on it too. What M1 built, and why, is in `docs/m1-report.md`.

## Layout

```
apps/web/            Next.js 16 App Router: board UI + REST API + SSE (the only process in M1)
  app/api/**/route.ts  thin handlers: parse with zod, call lib/, wrap with route() for {error:{code,message}}
  lib/projects.ts      project + board queries
  lib/tickets.ts       ticket/criteria/comment/activity mutations: one tx each = write + activity row + publish()
  lib/events.ts        publish() = pg_notify inside the tx; one LISTEN client per process fans out to SSE
  components/          board.tsx (dnd-kit), ticket-drawer.tsx, ui/ (shadcn, generated: don't hand-edit)
  e2e/                 Playwright; runs its own dev server on :3100 against database kanbot_test
packages/shared/     shared by web and (from M2) worker
  src/schemas.ts       zod API bodies + enums;  src/events.ts  SSE event union + NOTIFY channel
  src/workflow.ts      default columns;          src/ids.ts     uuidv7()
  src/db/schema.ts     Drizzle schema;           drizzle/       generated SQL migrations (commit them)
docs/requirements.md the spec
```

`apps/worker` and `agents/` don't exist yet. They arrive in M2.

## Commands (repo root)

```
docker compose up -d db     Postgres 16 on 127.0.0.1:5432 (cp .env.example .env first)
pnpm db:migrate             apply migrations;  pnpm db:generate --name <x>  after editing db/schema.ts
pnpm dev                    web on http://127.0.0.1:3000
pnpm typecheck | lint | test | test:e2e | build | format
```

`pnpm test:e2e` can run while `pnpm dev` is running: it uses `NEXT_DIST_DIR=.next-e2e` and its own database.

If `pnpm dev` returns 500 with a Turbopack panic about `globals.css` / exit code `0xc0000142`, delete `apps/web/.next`. This was seen on Windows after a `pnpm build` and killed dev servers. On Windows, stopping `pnpm dev` from a parent shell can leave the `next` node process alive on the port. Kill it by PID (`netstat -ano | findstr :3000`).

## Conventions

- TypeScript strict, everywhere. No Python anywhere (scripts and tooling included).
- IDs are UUIDv7 (`uuidv7()`), timestamps `timestamptz`, enums are `pgEnum`s built from the arrays in `schemas.ts`.
- Ticket order is a `fractional-indexing` key. Always `ORDER BY position COLLATE "C"` in SQL and compare with `<` (never `localeCompare`) in JS.
- Every ticket mutation writes an `activity` row and calls `publish()` in the same transaction. Clients refetch on every event (no client-side patching yet).
- Validate every API body and `[id]` param at the boundary (`parseBody`, `idParam`). Errors are `{error: {code, message}}`.
- A known-limited shortcut gets a `shortcut: <limit>, <when to upgrade>` comment.
- One `.env` at the repo root; `.env.example` lists every variable. Never commit secrets.
- Dependencies: pnpm 12 enforces a minimum release age. Pick a mature version rather than adding `minimumReleaseAgeExclude` entries.
- The app has no auth until M4 and binds to 127.0.0.1. Don't expose it.
