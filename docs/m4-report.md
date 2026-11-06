# M4 report: unblock (local)

Status: **done, pending review.** Built 2026-11-03 to 2026-11-05 in six phases:
- P1–P2 merged in PR #5;
- P3–P4 merged in PR #6;
- P5–P6 are on `m4-unblock-3`.

This report is a snapshot from the end of M4. Open items now live in `requirements.md` §16, "Still to build".

M4 in the spec (`requirements.md` §16): Blocked column with Rubber Duckworth, resume with answer, Archie's retro and worktree cleanup, in-app notifications, cost tracking and daily cap, Pause all, project Settings in the database, ticket links. M4 also owned its rows in "Still to build".
**Done when:** a `needs_input` run can be answered and resumed, Pause all and the daily cap stop new runs, and a ticket moved to Done gets Archie's retro and loses its worktree. Each part is covered without API calls by worker tests and Playwright tests on the replay runtime. Real-agent coverage is under "Real-agent checks" below.

On 2026-11-03, shipping (GitHub App, Captain Ship-It, CI tracking, PR Review, deployment, login) was split out of M4 into a new M5. Everything local is finished before any infrastructure is needed. The old M5 (polish) is now M6.

## What you can do

1. **Control spend.** The top bar shows today's spend against the daily cap (default $5). Once the cap is reached, no new run starts until midnight or until you raise the cap. A run that starts late in the day gets only the budget that is left.
2. **Pause all.** The top-bar switch stops running runs at once (`interrupted`, "Stopped by Pause all"). They restart by themselves when you resume. An Anthropic auth or billing error pauses everything, and the banner gives the error as the reason. After an outage, interrupted runs restart once a free probe (`models.list`) answers.
3. **Unblock a ticket.** When an agent asks for input, fails, times out, runs out of budget, stalls or hits the bounce limit, the ticket goes to **Blocked**. Rubber Duckworth (Haiku, read-only, about $0.25) posts a diagnosis with numbered questions, and you get a notification. Type an answer in the Blocked panel and click **Resume**. The ticket returns to its column, and the same agent continues its SDK session with your answer. At the bounce limit, Resume also resets the bounce count.
4. **Bounce-backs keep context.** When Code Review or QA sends a ticket back, Sir Codes-a-Lot resumes his last session instead of starting cold (FR-35).
5. **Finish a ticket.** Drag it to **Done**. The worker removes its worktree (the branch stays), and Archie the Archivist writes a retro: what was built, cost, bounces, lessons and CLAUDE.md suggestions. If the retro fails, the ticket stays in Done, flagged Failed, with Retry.
6. **Link tickets.** Plan B proposes related and blocking tickets. Nancy proposes a `blocks` link when she finds a blocking cross-ticket risk. The drawer's Links block lets you confirm, dismiss or add links by key. A confirmed, unfinished blocker joins the Ready → In Progress overlap check (409, "Start anyway" overrides). Cards show "waiting on" and overlap pills.
7. **Settings per project.** The Settings page (linked from the top bar) edits commands, test globs, hotspots, the bounce limit and concurrent runs. They are seeded once from `.kanbot/project.yml`; after that, edits to the file change nothing.
8. **See what a ticket cost.** The drawer shows "Cost so far", and Archie's retro includes it.
9. **Notifications.** The top bar's "Needs me" lists tickets waiting on you, and offers browser notifications when the tab is hidden. The agent notice in the top bar now clears when that ticket's run ends.

## How to run it

```
docker compose up -d db
pnpm install
pnpm db:migrate              # adds migrations 0004–0007
pnpm dev
```

To check it, run:
- `pnpm typecheck` and `pnpm lint`;
- `pnpm test`: 32 shared unit tests, plus 95 worker tests (1 skipped off Windows);
- `pnpm test:e2e` (11 tests) and `pnpm build`.

None of them calls the Anthropic API. GitHub Actions CI now runs typecheck, lint, test and test:e2e on every push and PR, with the replay runtime.

## What was built

| Phase | Area | Where | Notes |
| --- | --- | --- | --- |
| P1 | Settings, daily cap, Pause all | `settings` table (`drizzle/0004`), `runs.budget_usd`, `apps/worker/src/main.ts`, `run.ts` (`claimNext`), `GET/PATCH /api/settings`, top bar | Spend = runs ended today plus running runs' budgets. `settings.updated` SSE event |
| P1 | Outage and auth handling | `apps/worker/src/main.ts` | Auth/billing → pause with reason; interrupted runs restart once the probe answers, only if the ticket is still where the run left it |
| P1 | CI | `.github/workflows/ci.yml` | Postgres 16 service, replay only |
| P2 | Resume | `drizzle/0005`, `POST /api/runs/:id/resume`, `run.ts` | `awaiting_input` is terminal; `resume_session_id` on the new run; the answer is in context as `<owner_answer>` |
| P2 | Rubber Duckworth | `agents/rubber-duckworth.md`, `context.ts` | Runs on entry to Blocked; plain fallback comment if his run fails; sees earlier blocker summaries (recurring block) |
| P2 | Stall rules | `run.ts` | No progress: 25 tool calls with no edit and no test run, editing agents only. Recurring block: Duckworth's |
| P2 | Notifications | `notification` SSE event, `components/board.tsx` | Needs me list, browser notifications |
| P3 | Archie and Done | `agents/archie-the-archivist.md`, `transitions.ts` (Done rows), `worktree.ts` (`removeWorktree`) | Retro context: run history, total cost, bounces, diff stat. The eval moves finished golden tickets to Done |
| P4 | Ticket links | `ticket_links` (`drizzle/0006`), `lib/tickets.ts` (`addLink`), `/api/tickets/:id/links`, `/api/links/:id`, `verdict.ts` (`relatedTickets`) | Proposals are stored unconfirmed; Plan B gets `<open_tickets>` |
| P5 | Project settings | `projects` columns (`drizzle/0007`), `db/ops.ts` (`projectConfigOf`), `/api/projects/:id`, `components/settings-form.tsx` | Per-project bounce limit (`afterRun`'s `bounceLimit`) and concurrency (`claimNext` SQL); drawer cost total |
| P6 | Smaller items | `runtime/sdk.ts`, `worktree.ts`, `board.tsx`, `eval.ts`, `fixtures/golden/review.json` | Resume resets the bounce count at the limit; 10-minute Bash timeout; reinstall on lockfile change; only our plugins load; the notice clears on `run.finished`; the golden bounce ticket |

New endpoints:
- `GET/PATCH /api/settings`;
- `POST /api/runs/:id/resume`;
- `POST /api/tickets/:id/links`;
- `PATCH/DELETE /api/links/:id`;
- `GET/PATCH /api/projects/:id`.

New SSE events: `notification` and `settings.updated`.

Tests grew from 26 + 75 + 6 to 32 + 95 + 11 (shared, worker, e2e).

## Key decisions

- **A `needs_input` run ends.** Under M3's index, an `awaiting_input` run stayed active, and the one-active-run index then left Duckworth no room to run. Now `awaiting_input` is terminal, like `failed`. It keeps its session ID, and Resume starts a *new* run with `resume_session_id`. If the session file is gone, the run starts cold with the same context.
- **Pause all stops runs at once** rather than "after the current step" (FR-63). Interrupted runs restart by themselves, so nothing is lost. A step boundary isn't observable from the SDK.
- **The worker removes the worktree at Done, not Archie.** It does this before his run starts, so a failed or skipped retro never leaves a worktree behind. Archie only reads.
- **Agent link proposals wait for the owner.** Only confirmed links block, and a blocker is overridable with "Start anyway", like an overlap.
- **The database is the source of project settings.** `.kanbot/project.yml` seeds a project once, on its first read; the file is still read only from the default branch. An empty command from the form is dropped before storing (`""` would fail `projectConfig` and break every read).
- **Costs per ticket: total only.** The per-ticket $3 budget moved to M6 (decided 2026-11-05).
- **Resume at the bounce limit resets the count.** Otherwise the resumed reviewer's next change request would send the ticket straight back to Blocked. It is logged as an `edited` activity, since a new activity enum value would need a migration.
- **The golden bounce comes from a late acceptance criterion.** `eval.ts` adds the review ticket's `reviewCriterion` ("PATCH with a title longer than 100 characters returns 400…") when it first enters Code Review. Bad hints in the description didn't work: in M3 Sir Codes-a-Lot ignored them, and in M4 Plan B rejected them while planning. A late owner *comment* (P6's first try) asked only for what was already built, and Nancy treats comments as background. Criteria she checks.
- **Bundled plugins are switched off by name.** `settings.enabledPlugins` sets the three `@builtin` ids to false; a real session aborted at init then listed only `ponytail`.

## Changes to the spec (`requirements.md`)

Every departure from the spec is edited into the spec itself. This list says where:

| Change | Why | Where in the spec |
| --- | --- | --- |
| **Shipping split out of M4 into M5**; old M5 polish becomes M6. GitHub endpoints, Ship-It, Marge, Agents/Costs pages and phone approvals move one milestone later | Finish everything local before any infrastructure | §16 milestones, §12, §9, §13, §17 |
| `awaiting_input` is terminal; Resume starts a new run with `resume_session_id`; Resume body `{answer?}` and works after `failed`, `timed_out`, `budget_exceeded`, bounce limit and `interrupted` too | Duckworth couldn't run beside an active `awaiting_input` run | §8 Resume, §11 `runs`, §12 resume endpoint, UC-7 |
| Pause all stops runs at once; they restart on resume | No observable step boundary; nothing is lost | FR-63, §8 failure handling |
| Auth/billing error: the run fails and all agents pause with the error as the reason | One place to see and clear it | §8 failure handling |
| Daily spend counts running runs' budgets; a late run gets only what is left | Cost is known only when a run ends | §14 budgets |
| `POST /api/settings/pause` became `GET/PATCH /api/settings` (also the daily cap) | One settings resource | §12 |
| No-progress stall: 25 tool calls with no edit and no test run, editing agents only; recurring block is in Duckworth's context | Read-only agents read many files by design | §8 stall table |
| Repeated-feedback stall → M6 | Needs fuzzy matching; the bounce limit stops the loop | §8, §16 M6 |
| The worker, not Archie, removes the worktree; a failed retro leaves the ticket in Done | A retro failure shouldn't leak worktrees | §3 manual moves, §4 Archie, UC-9, FR-49 |
| Links: `project_id`, `confirmed`, `source` columns; agent proposals are unconfirmed; blockers are overridable with Start anyway | Agents propose, the owner decides | FR-14, §3, §9, §11, §12 |
| Project commands, test globs and hotspots live in the database; `project.yml` only seeds them | Settings page | §8 tools, §9 hotspots, §11, §12, §13 |
| Bounce limit and concurrency per project; global concurrency stays a constant | Only per-project was needed | FR-23, §14 |
| Per-ticket budget → M6; M4 shows the ticket's total | Total cost is enough to judge; a budget needs a policy | §14, §16 M6 |
| Running cost while a run works → M6 | Per-turn messages carry tokens, not dollars; needs a price table | §16 M6 |
| Playwright QA and the four extra plugins → M6; WIP limits and auto_advance → M6; dark theme → M6 | Each plugin needs its own eval spend; WIP limits matter with auto-pull | §8, §16 M6 |
| `blockWritesOutsideWorkingDirectories` and the SDK sandbox → M5 | Needs a newer Claude Code; sandbox is Linux/macOS only | §7, §14, §16 M5 |
| The agent Bash tool gets a 10-minute timeout via `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` | Was bounded only by the run timeout | §8 failure handling |
| Reinstall when the lockfile changes (marker in the worktree's git dir) | Was install-on-create only | §8 step 2 |
| `notification` event has an optional `ticketId` and a `paused` kind; new `settings.updated` event | Global pauses have no ticket | §12 events, §13 top bar |

§16 marks the M4 rows done (deleted) and adds dated "Moved from M4" notes to the M5 and M6 rows.

## What was left out on purpose

Everything cut from M4 is in "Still to build" in `requirements.md` §16, with its milestone:
- the per-ticket budget, a running cost while a run works, WIP limits, Playwright QA, the four extra plugins, the repeated-feedback stall and the dark theme (M6);
- `blockWritesOutsideWorkingDirectories` and the SDK sandbox (M5).

Settings doesn't yet edit QA settings, the repo path or global concurrency.

`shortcut:` comments:
- New: a hotspot glob can't contain a comma (Settings);
- New: Plan B's `<open_tickets>` lists the first 100 open tickets by number;
- New: the bundled-plugin list is fixed, so re-check the init plugins on each SDK upgrade;
- Removed: the agent notice now clears;
- Retargeted: existing comments for the running cost, side-by-side diff, worktree cleanup and worker lock now name their new milestone.

## Real-agent checks

- **P2 golden eval:** all four reached QA with 0 bounces, $1.45 against the $1.40 baseline. The baseline was not re-saved.
- **P6 plugin check:** a real session aborted at init showed only `ponytail` loaded.
- **Final golden eval (2026-11-05, `pnpm eval:agents`, $1.43):** all four tickets reached QA and then Done with Archie's retro, with 0 bounces. Each was within the baseline's cost, so the baseline was not re-saved.

  | Ticket | Cost | Time | Diff |
  | --- | --- | --- | --- |
  | bug | $0.34 | 89 s | 3 files, +22 −1 |
  | feature | $0.43 | 119 s | 5 files, +50 −7 |
  | review | $0.38 | 134 s | 3 files, +69 −1 |
  | ui | $0.28 | 96 s | 2 files, +82 −1 |

  - **Related tickets work.** Plan B proposed 6 unconfirmed `relates` links between the four tickets, e.g. the due-date and rename tickets both touch `src/todos.ts` and the PATCH tests. Two pairs were proposed in both directions (A→B and B→A); that is harmless, but the drawer shows both.
  - **Archie ran on all four**, e.g. "Retro written: PATCH now renames a todo from a `title` body (trimmed, validated, owner's mass-assignment hint rejected), with 5 tests. Cost $0.38 over 4 runs, 0 bounce-backs."
  - **The golden bounce did not happen.** Plan B rejected the `Object.assign` hint while planning, so Sir Codes-a-Lot copied only `title` and wrote tests. The late owner comment reached Code Review as designed, but it asked for what was already done, and Nancy approved. Fixed the same day with a late criterion (below).
  - Nancy raised `test_conflict` warnings (not blocking) between the due-date and rename tickets, as in M3.
- **Session resume after Blocked (2026-11-05, ~$0.40 over two runs).** A script drove the real web app and worker on a throwaway database. It set the daily cap a few cents above today's spend and moved a ticket to Planning. Plan B ran out of budget, the ticket went to Blocked and Duckworth diagnosed it. The script then raised the cap and clicked Resume. **Pass:** the resumed Plan B run had `session_id` = `resume_session_id` = the blocked run's session, and it finished the plan.
  - **Bug found and fixed:** the first run ended `failed` ("Claude Code returned an error result: Reached maximum budget"), not `budget_exceeded`, and recorded **$0.00** although it spent $0.04. The SDK sends the error result, then throws; the worker's catch threw the result away. `sdk.ts` now keeps the result when one arrived (test: `apps/worker/test/sdk.test.ts`, which fails without the fix). Max-turns runs took the same path. The second run, on the fixed worker, ended `budget_exceeded` with its $0.06 recorded.
  - Seen, not fixed (spec §14 and the M6 "Running cost" row): the SDK checks the budget between turns, so a run can overshoot it ($0.06 on $0.035), and a cancelled run (Duckworth, cancelled by Resume) records $0.
- **Real bounce and bounce-back resume (2026-11-05, `pnpm eval:agents --only=review`, $0.80).** With the late criterion, Nancy requested changes ("the owner's open criterion is not implemented: a title longer than 100 characters should return 400"). The ticket bounced to In Progress, where Sir Codes-a-Lot's run **resumed his first session** (`resume_session_id` = `session_id` = his first run's) and added the check and two tests. Then Nancy approved, Testy passed it and Archie wrote the retro. The resumed run cost $0.34 against $0.22 for the first: the resumed session carries the whole earlier transcript.
  - The eval reported "total bounces rose from 0 to 1", because `evals/baseline.json` predated the new ticket. It was re-saved below.
- **Baseline re-save attempt (2026-11-05, full `pnpm eval:agents --baseline`, $2.15). Not kept.** bug, review and ui reached Done; review bounced once, as planned. The feature (due date) ticket stuck in In Progress: Nancy found its code correct but requested changes because the rename ticket's tests compare todos against `{id,title,done}` and break once todos get `dueDate`. Those tests exist only on the rename branch, so Sir Codes-a-Lot could not fix them and ended with `changes_requested`. The script had saved the run as the baseline anyway; the old one was restored.
  - Fixes: Nancy's prompt now uses `blocking` only when the fix belongs on the ticket's own branch, and never requests changes for a cross-ticket conflict alone (spec §9). `--baseline` now refuses a run in which any ticket missed QA. 
- **Baseline re-saved (2026-11-05, full `pnpm eval:agents --baseline`, $1.88). Pass.** All four tickets reached Done; the only bounce is the review ticket's planned one. Nancy reported the due-date/rename test overlap as a `warning` ("whichever ticket merges second must add dueDate: null") on both tickets, and the feature ticket went through with no bounce. Every cross-ticket risk in the run was a warning. Saved as `evals/baseline.json` (bounces 1, $1.88).
- M4's real spend: $1.45 (P2 eval) + $1.43 (final eval) + $0.40 (resume check) + $0.80 (bounce check) + $2.15 (baseline attempt) + $1.88 (baseline re-save) + a few cents for the plugin init check, about $8.15.

## Repeating the session-resume checks

- **After Blocked:** run the real web app and worker on a throwaway database. Set the daily cap a few cents above today's spend, move a ticket to Planning, wait for Blocked, raise the cap and click Resume. On the resumed run, `session_id` must equal `resume_session_id`. If they differ, the session file wasn't found and the run started cold, which `sdk.ts` does silently.
- **On a bounce:** `pnpm eval:agents --only=review` (about $0.80). Sir Codes-a-Lot's second run must have `resume_session_id` = his first run's `session_id`.

## Known risks

- **Agents run real commands on your machine**, as in M3. The write block is the permission hook's alone until M5.
- **Test globs from Settings are Testy's edit scope.** A broad glob (e.g. `**/*`) lets him edit source files; Settings checks only that each glob is non-empty.
- **Tested only on Windows** locally; CI runs on Linux.
