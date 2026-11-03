# M1 report: board without agents

Status: **done, awaiting review.** Built 2026-11-02. Nothing is committed yet (the repo has `git init` only).

M1 in the spec (`requirements.md` §16): monorepo scaffold, Docker Compose, Postgres + Drizzle schema/migrations, project creation, tickets with acceptance criteria and comments, a drag-and-drop board with the default columns, an activity log, and SSE for moves.
**Done when:** tickets can be created and moved, and the board updates live in two browser tabs. That works and is covered by the e2e test.

## What you can do

1. Create a project with a name, a key prefix (e.g. `KB`) and a default branch. It gets the 10 default columns: Backlog, Planning, Ready, In Progress, Code Review, QA / Testing, Ship, PR Review, Done and Blocked.
2. Quick-add tickets from the top bar. They land at the bottom of Backlog with keys `KB-1`, `KB-2`, and so on.
3. Drag cards between columns or reorder them within a column, using the mouse or the keyboard (Space to pick up, arrow keys to move, Space to drop, Escape to cancel).
4. Every change appears live in every open tab showing that board. A reload shows the same state.
5. Open a card (click it, or press Enter) to show the ticket drawer:
   - edit the title, type, priority, labels and description;
   - add, edit, remove and mark acceptance criteria (open, pass or fail);
   - add comments;
   - read the activity timeline (created, moves with from → to, edits, comments);
   - delete the ticket.
6. Switch between projects from the top bar.

## How to run it

```
cp .env.example .env
docker compose up -d db      # Postgres 16 on 127.0.0.1:5432
pnpm install
pnpm db:migrate
pnpm dev                     # http://127.0.0.1:3000
```

To check it: `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit), `pnpm test:e2e` (Playwright: the two-tab flow) and `pnpm build`.

## What was built

| Area | Where | Notes |
| --- | --- | --- |
| Workspace | root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | pnpm 12, TypeScript strict, Prettier, ESLint 9 |
| Database | `docker-compose.yml`, `packages/shared/src/db/schema.ts`, `packages/shared/drizzle/` | Postgres 16; tables `projects`, `columns`, `tickets`, `acceptance_criteria`, `comments`, `activity` |
| Shared code | `packages/shared/src/` | zod request schemas, the event types, the default columns, `uuidv7()` |
| REST API | `apps/web/app/api/**` with logic in `apps/web/lib/` | every body and id validated; errors are `{error:{code,message}}` |
| Live updates | `apps/web/lib/events.ts`, `app/api/events/route.ts` | `pg_notify` inside each write transaction → one LISTEN connection per process → SSE to the browsers |
| Board UI | `apps/web/components/board.tsx` | Next.js 16, React 19, Tailwind 4, shadcn/ui, dnd-kit; moves are optimistic and roll back if the server refuses them |
| Ticket drawer | `apps/web/components/ticket-drawer.tsx` | refetches when an event for the open ticket arrives |
| Tests | `packages/shared/src/ids.test.ts`, `apps/web/e2e/board.spec.ts` | the e2e test runs on port 3100 against its own `kanbot_test` database |
| Project docs | `CLAUDE.md` | layout, commands, conventions, troubleshooting |

Endpoints: `GET/POST /api/projects`, `GET /api/projects/:id/board`, `POST /api/projects/:id/tickets`, `GET/PATCH/DELETE /api/tickets/:id`, `POST /api/tickets/:id/move`, `GET/POST /api/tickets/:id/comments`, `GET /api/tickets/:id/activity`, `POST /api/tickets/:id/criteria`, `PATCH/DELETE /api/criteria/:id` and `GET /api/events?projectId=`.

## Key decisions

- **IDs are UUIDv7, generated in the app.** Postgres 16 has no `uuidv7()`.
- **Ticket numbers come from `projects.ticket_seq`, bumped with `UPDATE … RETURNING`.** The row lock keeps numbering atomic.
- **Card order is a `fractional-indexing` key, sorted with `COLLATE "C"`.** The default collation sorts these keys wrongly.
- **The browser refetches the whole board on every event and on every reconnect.** That makes it correct after a dropped connection without replaying missed events.
- **Live events are unnamed SSE messages; the event type is inside the data.** Named events never reach `EventSource.onmessage`.
- **In M1 any column can move to any column.** The transition table arrives with the agents.

## Changes to the spec (`requirements.md`)

- §11: new activity action `created`.
- §12: new criteria endpoints (§12 had no way to edit criteria), new live events `ticket.created` and `ticket.deleted`, and a note that events are unnamed.
- §16: M1 marked done, plus a new **"Deferred from M1"** table.

## What was left out on purpose

Everything cut from M1 is in the "Deferred from M1" table in `requirements.md` §16, with the milestone that picks it up. Main items:
- the worker process and the agents (M2);
- login and GitHub (M4);
- WIP limits (M3);
- Markdown rendering (M2);
- the web, worker and Caddy services in Compose (M4);
- CI (once there is a remote).

The code has three `shortcut:` comments where a simple version has a known limit: no SSE replay, the reconnect gap in the listener, and the duplicate-key fallback on drop.

## Problems found and fixed while testing

- **Live updates never reached the browser.** The server sent named SSE events, which the browser's `onmessage` handler ignores. Events are now unnamed.
- **Dropping a card into another column did nothing.** The `closestCorners` collision check picked the card's old slot. Switched to `rectIntersection`.
- **Screen readers heard raw UUIDs during a drag.** The announcements now use ticket keys and column names.
- **The keyboard e2e test was flaky.** It pressed keys before the drag had started. It now waits for the screen-reader announcements.
- **The e2e run clashed with a running `pnpm dev`.** The e2e server now uses its own build folder (`.next-e2e`).
- **The dev server listened on every network interface.** It is now bound to `127.0.0.1`, because there is no login yet.

## Known risks

- **No login until M4.** Keep port 3000 local.
- **Tested only on Windows.** The spec targets macOS and Linux for development.
- **On Windows, a stopped dev server can stay alive on its port.** A Turbopack cache panic (fixed by deleting `apps/web/.next`) was also seen. Both are noted in `CLAUDE.md`.
- **Events sent while the listener is reconnecting are lost.** The board catches up on the next event or reload.

## Environment setup done on this machine

- pnpm 12 installed globally with npm. Its folder is not on Git Bash's PATH, so run `export PATH="$APPDATA/npm:$PATH"` first.
- Docker Desktop started.
- Playwright's Chromium installed.
