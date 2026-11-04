# M2 report: orchestrator and Plan B

Status: **done.** Built 2026-11-02, merged in PR #1.
This report is a snapshot from the time of the merge. Open items now live in `requirements.md` §16, "Still to build".

M2 in the spec (`requirements.md` §16): job queue, worker process, `AgentRuntime` adapter on the Claude Agent SDK, agent file loader, context assembly, `report_result` tool, run events streamed to the Live tab, cancel and retry, per-run budget, the replay runtime for tests, API retry with backoff, and the health indicator. M2 also owned its rows in "Deferred from M1".
**Done when:** moving a ticket to Planning produces a plan artifact and a "Plan ready" flag. That works with the real SDK (smoke test below) and is covered without API calls by a Playwright test and the worker tests (replay runtime).

## What you can do

1. Create a project with an optional **local repo path**. Plan B reads that checkout. Without one, it plans from the ticket alone.
2. Drag a ticket to **Planning**. The top bar says "Plan B is on it." and the card shows a spinning **Working** pill. When Plan B finishes, the card shows **Plan ready · needs you** and the "Needs me" count goes up.
3. Open the card. The drawer shows:
   - the **latest run** (agent, state, elapsed time, cost, summary or error), with **Cancel run** while it works and **Retry** after a failure;
   - acceptance criteria written by the plan, marked "from plan" (your own criteria are never replaced);
   - tabs: **Activity**, **Live** (the agent's messages, tool calls and results, collapsible, updating live), **Artifacts** (the plan rendered as Markdown; older versions kept, collapsed under the latest), **Comments** (rendered as Markdown).
4. On the Artifacts tab, type what to change under the plan and click **Revise plan**. Plan B re-runs at once and writes v2; v1 is kept. Comments are separate: general notes Plan B reads as background, and they never start a run. (Dragging out of Planning and back in still re-plans too.)
5. Drag a ticket whose agent is working. You're asked first, then the run is cancelled.
6. Drag to **Ready** to approve the plan (it clears the flag).
7. A failed, over-budget or `needs_input` run moves the ticket to **Blocked** (Rubber Duckworth arrives in M4). An API outage leaves it in place, flagged **Failed**, with Retry.
8. The top bar shows a health line ("All systems ok", or e.g. "worker down"), and Planning's column header shows Plan B's avatar.

## How to run it

```
cp .env.example .env         # then set ANTHROPIC_API_KEY, or KANBOT_RUNTIME=replay for scripted runs
docker compose up -d db
pnpm install
pnpm db:migrate              # adds migration 0001_runs
pnpm dev                     # web on http://127.0.0.1:3000 + worker
```

To check it: `pnpm typecheck`, `pnpm lint`, `pnpm test` (shared unit tests + worker tests against `kanbot_test`), `pnpm test:e2e` (web + replay worker) and `pnpm build`. None of them calls the Anthropic API.

## What was built

| Area | Where | Notes |
| --- | --- | --- |
| Schema | `packages/shared/src/db/schema.ts`, `drizzle/0001_runs.sql` | Tables `runs`, `run_events`, `artifacts`. Columns `tickets.status_flag`, `acceptance_criteria.source`, `projects.repo_path`. Partial unique index: one active run per ticket. |
| Transition table | `packages/shared/src/transitions.ts` | Data plus `afterRun()`. M2 wires Planning success → stay + `plan_ready`; failed / timed out / over budget / needs input → Blocked; interrupted and cancelled → stay. |
| Shared writes | `packages/shared/src/db/write.ts`, `ops.ts` | `publish()`, `logActivity()`, `startColumnAgent()`, `cancelActiveRun()`, `moveToColumnEnd()`, used by both web and worker |
| Verdict | `packages/shared/src/verdict.ts` | zod `report_result` schema (`verdict`, `summary`, `artifacts`, `acceptanceCriteria`, `questions`) |
| Agent files | `packages/shared/src/agents.ts`, `agents/plan-b.md`, `agents/avatars/plan-b.svg` | Frontmatter checked with zod, read on every run. A missing file makes the column a gate. |
| Worker | `apps/worker/src/` | Claim loop (NOTIFY + 5 s poll), concurrency 2 global / 1 per project, crash recovery, timeouts, cancel via AbortController |
| SDK runtime | `apps/worker/src/runtime/sdk.ts` | `query()` with built-in tools limited to the frontmatter, PreToolUse allowlist hook, `report_result` as an always-loaded in-process MCP tool, `maxTurns`, `maxBudgetUsd`, `settingSources: []`, no `DATABASE_URL` in the agent's env |
| Replay runtime | `apps/worker/src/runtime/replay.ts`, `fixtures/runs/plan-b/*.json` | 8 scripts: default, slow, no-report, malformed, budget, needs-input, rate-limit, outage |
| Context bundle | `apps/worker/src/context.ts` | Ticket, criteria, latest plan, last 3 runs, owner comments since the last run (background), project CLAUDE.md, and the revision request on Revise plan runs, in delimited sections |
| API | `apps/web/app/api/runs/**`, `tickets/[id]/runs`, `health`, `agents/[slug]/avatar` | Move now cancels (with `confirmCancel`) and enqueues |
| UI | `components/board.tsx`, `ticket-drawer.tsx`, `markdown.tsx`, `ui/tabs.tsx` | Status pills (icon + text), column avatar, agent notice, cancel confirmation, "Needs me", health line, drawer tabs, Live log |
| Tests | `packages/shared/src/*.test.ts`, `apps/worker/test/run.test.ts`, `apps/web/e2e/agents.spec.ts` | 14 unit tests, 12 worker tests, 3 e2e tests (M1's plus two for M2) |
| Lint | `eslint.config.mjs` | typescript-eslint for `packages/shared` and `apps/worker` |

New endpoints: `GET /api/tickets/:id/runs`, `GET /api/runs/:id/events?after=seq`, `POST /api/runs/:id/cancel`, `POST /api/runs/:id/retry`, `GET /api/health`, `GET /api/agents/:slug/avatar`. `POST /api/tickets/:id/move` takes `confirmCancel`, and `GET /api/tickets/:id` now includes `runs` and `artifacts`.

## Key decisions

- **No pg-boss: the `runs` table is the queue** (agreed before building). The worker claims with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` under an advisory lock, so the global and per-project limits are exact. There is no second job record to keep in sync with the run row.
- **Web and worker talk only through Postgres.** The web app inserts a queued run in the move's transaction; its NOTIFY wakes the worker. A cancel is a `run.finished` event the worker hears and turns into `abort()`. The worker writes `cancelled` nowhere, and its final update only touches runs still `running`, so a cancel is never overwritten.
- **Each run event is stored first, then announced by id.** NOTIFY payloads are capped at 8 KB, and tool results are bigger. The Live tab pages `/api/runs/:id/events?after=seq`.
- **The agent file is read on every run.** That is FR-30's hot reload, with no file watcher. A missing file makes the column a gate, so the other columns behave as before until their agents ship.
- **API retries are the SDK's.** The Agent SDK already retries 429/5xx with backoff and emits `api_retry` messages, so the worker logs them ("waiting on API") rather than retrying again on top. If the SDK gives up, the run becomes `interrupted` (stays put, Retry); auth and billing errors → `failed`.
- **The plan's criteria replace the plan's criteria.** On a successful plan, agent-written criteria are replaced and the owner's are never touched.
- **Retry moves the ticket back.** A failed Plan B run has moved the ticket to Blocked, so Retry returns it to Planning and queues a new run, as if you'd dragged it.
- **Plan B runs in the project checkout.** No worktree exists before In Progress. It is read-only: only `Read`, `Grep`, `Glob` exist for it, and a hook refuses anything else.
- **The worker is "up" while it holds a Postgres connection named `kanbot-worker`.** That avoids a heartbeat table.

## Changes to the spec (`requirements.md`)

Every departure from the spec is edited into the spec itself. This list says where:

| Change | Why | Where in the spec |
| --- | --- | --- |
| Runs-table queue instead of pg-boss | One record per run, limits in one SQL query, one less dependency | §7 stack + process responsibilities, §8 lifecycle steps 1–2, §11 `runs`, §16 M2 |
| Only Plan B's agent file ships in M2; each other file ships with its milestone | Prompts written before their tools and context exist would be guesses | §17 instruction, §16 "Deferred from M2" |
| `projects.repo_path` pulled from M3 into M2, optional | Without it a real Plan B has no code to read | §11 settings note, §16 deferred row |
| Plan B runs read-only in the project checkout | No worktree exists before In Progress | §8 step 4, §14 code safety |
| Verdict gains `acceptanceCriteria`; each milestone adds the fields its agents use | §8's example had no field for Plan B's checklist | §8 verdict payload |
| `run.event` carries ids only and goes to every client of the project | NOTIFY's 8 KB cap | §12 SSE |
| A column whose agent file is missing is a gate | Lets agents ship one milestone at a time | §3, §8 agent definition |
| API retries come from the SDK; after it gives up → `interrupted` | Avoids retrying twice | §8 failure handling |
| Health: worker via `pg_stat_activity`; Anthropic judged from recent runs | No `settings` / heartbeat table needed yet | §8 health line |
| Hot reload = read the file on every run | No watcher to maintain | FR-30, §8 agent definition |
| `settings` table moved to M4 | Its first user is Pause all | §11, §16 |
| New endpoints `GET /api/health` and `/api/agents/:slug/avatar`; Retry returns the ticket to the run's column | Health was mentioned only in §8; avatars live in `agents/` | §12 |
| Replay scenario picked by a ticket label `replay:<name>` | Lets an e2e test choose a script | §8 testing |
| Recorded runs → M3 | Hand-written scripts cover M2 | §8 testing, §16 |
| Revising a plan is its own action (Revise plan box on the Artifacts tab), separate from comments; added after review at the owner's request | Comments are general notes (and later @mentions), not instructions; re-planning shouldn't need a drag out and back | UC-3, §3 Planning row, §11 `runs.request_md`, §12 `revise-plan`, §16 deferred context row |

§16 marks M2 done, updates the M1 rows M2 handled (✓) or moved, and adds a **"Deferred from M2"** table.

## What was left out on purpose

Everything cut from M2 is in the "Deferred from M2" table in `requirements.md` §16, with the milestone that picks it up. Main items:
- the other eight agent files (M3–M5);
- `Bash(cmd:*)` allowlist patterns and scrubbed shells (M3);
- branch-dependent context and the Diff tab (M3);
- plugins (M3);
- recorded runs and golden tickets (M3);
- live running cost (M4);
- the outage banner and auto-resume (M4);
- `settings` (M4).

One design conflict is recorded for M4: a `needs_input` run stays active (`awaiting_input`), and the one-active-run index would then stop Rubber Duckworth from running on that Blocked ticket.

New `shortcut:` comments:
- the hook matches exact tool names only;
- notifications are missed while the worker's LISTEN reconnects;
- any API retry marks the health line degraded until the run ends;
- no cost is shown while a run is working.

## Real-agent smoke test

Plan B ran with the real SDK (`claude-opus-5-5`) on a project pointing at this repo. The ticket was "Serious mode: a toggle that swaps the agents' funny status lines for plain ones".

| Run | Result | Cost | Time | Notes |
| --- | --- | --- | --- | --- |
| 1 | success, plan v1 + 6 criteria | $0.45 | 91 s | Read the spec and the board code, proposed a small localStorage-based plan, sized S |
| 2 (after an owner comment, dragged back to Planning) | success, plan v2 (v1 kept) | $0.16 | 39 s | Followed the comment; 49k input tokens (mostly cache), 4.3k output |

Run 1 found four adapter problems, fixed before run 2:
- **Every Claude Code tool was offered to the agent** (Bash, Edit…). The hook did refuse the one off-list call, but write tools are now not offered at all (`tools` option).
- **`report_result` was deferred behind tool search.** The agent tried ToolSearch (refused) and its first call missed required fields. The tool is now always loaded (`alwaysLoad`). Run 2 had no errors.
- **Input tokens read 18.** `usage` excludes cache tokens. Counts now come from `modelUsage`.
- **The `init` event listed all tools.** It now lists `Glob, Grep, Read, mcp__kanbot__report_result`.

The smoke project "Kanbot smoke" (ticket SMOKE-1, two plans) is still in your dev database if you want to look at it in the UI.

**Please review `agents/plan-b.md`.** Prompt quality decides plan quality. The two smoke plans read well, but that's two tickets.

## Problems found and fixed while testing

- The M1 e2e test broke in two ways:
  - Its `getByRole("status")` would also match the new notices. The agent notice is now `aria-live` without `role="status"`, and the run bar is a labelled section.
  - Its move to Planning now starts Plan B, so it waits for "Plan ready" before the next move.
- **Comments moved into a tab.** The M1 test clicks the tab first.
- **A pointer drag to the left dropped back on the same column.** `rectIntersection` weighs the dragged card's rect, and the test grabbed the card's left edge. The test now grabs the middle, and the cancel test moves by keyboard.
- **The cancel confirmation arrives after the optimistic move.** The e2e test polls for the dialog rather than checking it once.
- **Turbopack traced the whole repo** because the agents folder path is computed at runtime. Fixed with `turbopackIgnore`, since agent files are runtime data.
- **The worker tests passed on the first run, so I broke a rule on purpose.** Changing `plan_ready` to `none` in the transition table makes 2 of them fail. Then restored.

## Known risks

- **Real runs cost money** and run with your API key. Plan B's budget is $1 per run, and there is no daily cap until M4.
- **Plan B reads whatever folder `repo_path` points at.** Point it only at your own repos. The path is checked to be an existing absolute folder, nothing more (no auth until M4).
- **One worker process assumed.** The advisory lock keeps claims correct with more, but cancel delivery and crash recovery assume one. A second worker starting up would mark the first worker's running runs `interrupted`.
- **Tested only on Windows**, as with M1.

## Environment notes

- Your `next dev` (started 8:11 PM) was running the whole time. Deleting `apps/web/.next` after `pnpm build` (per CLAUDE.md) made it restart its server process. It's still up on :3000, serving the M2 code. For the smoke test I started only the worker (`pnpm dev:worker`) and stopped it afterwards.
- In Git Bash the pnpm shim fails; `export PATH="$APPDATA/npm/node_modules/pnpm:$PATH"` works. MSYS also strips backslashes from Windows paths in `node -e` arguments. Both are noted in `CLAUDE.md`.
