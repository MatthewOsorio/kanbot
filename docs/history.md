# Milestone history

What M1 to M5 decided and how each changed the spec, copied from their reports. How-to-run notes, test logs and real-agent check logs were dropped; the full reports are in git history (`git log -- docs/m3-report.md`, `docs/m5-report.md`). What is still to build is in `requirements.md` §16. A milestone in progress keeps a living `docs/m<n>-report.md`, folded in here when it closes.

## M1: board without agents

### Key decisions

- **IDs are UUIDv7, generated in the app.** Postgres 16 has no `uuidv7()`.
- **Ticket numbers come from `projects.ticket_seq`, bumped with `UPDATE … RETURNING`.** The row lock keeps numbering atomic.
- **Card order is a `fractional-indexing` key, sorted with `COLLATE "C"`.** The default collation sorts these keys wrongly.
- **The browser refetches the whole board on every event and on every reconnect.** That makes it correct after a dropped connection without replaying missed events.
- **Live events are unnamed SSE messages; the event type is inside the data.** Named events never reach `EventSource.onmessage`.
- **In M1 any column can move to any column.** The transition table arrives with the agents.

### Changes to the spec (`requirements.md`)

- §11: new activity action `created`.
- §12: new criteria endpoints (§12 had no way to edit criteria), new live events `ticket.created` and `ticket.deleted`, and a note that events are unnamed.
- §16: M1 marked done, plus a new **"Deferred from M1"** table.

## M2: orchestrator and Plan B

### Key decisions

- **No pg-boss: the `runs` table is the queue** (agreed before building). The worker claims with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` under an advisory lock, so the global and per-project limits are exact. There is no second job record to keep in sync with the run row.
- **Web and worker talk only through Postgres.** The web app inserts a queued run in the move's transaction; its NOTIFY wakes the worker. A cancel is a `run.finished` event the worker hears and turns into `abort()`. The worker writes `cancelled` nowhere, and its final update only touches runs still `running`, so a cancel is never overwritten.
- **Each run event is stored first, then announced by id.** NOTIFY payloads are capped at 8 KB, and tool results are bigger. The Live tab pages `/api/runs/:id/events?after=seq`.
- **The agent file is read on every run.** That is FR-30's hot reload, with no file watcher. A missing file makes the column a gate, so the other columns behave as before until their agents ship.
- **API retries are the SDK's.** The Agent SDK already retries 429/5xx with backoff and emits `api_retry` messages, so the worker logs them ("waiting on API") rather than retrying again on top. If the SDK gives up, the run becomes `interrupted` (stays put, Retry); auth and billing errors → `failed`.
- **The plan's criteria replace the plan's criteria.** On a successful plan, agent-written criteria are replaced and the owner's are never touched.
- **Retry moves the ticket back.** A failed Plan B run has moved the ticket to Blocked, so Retry returns it to Planning and queues a new run, as if you'd dragged it.
- **Plan B runs in the project checkout.** No worktree exists before In Progress. It is read-only: only `Read`, `Grep`, `Glob` exist for it, and a hook refuses anything else.
- **The worker is "up" while it holds a Postgres connection named `kanbot-worker`.** That avoids a heartbeat table.

### Changes to the spec (`requirements.md`)

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

## M3: build loop

### Key decisions

- **The permission hook is the fence, not the SDK's rules.** The current SDK docs say read-only shell commands (`cat`, `ls`, `find`, read-only `git`) run without approval in every permission mode, `dontAsk` included. So `allowedTools: ["Bash(git diff:*)"]` alone would still let an agent `cat ~/.ssh/id_rsa`. The hook matches `Bash(...)` rules itself, refuses anything that chains, redirects or substitutes, and refuses arguments that name paths outside `cwd` or git flags that reach outside the repo. The SDK runs in `dontAsk` with `blockReadsOutsideWorkingDirectories` as a second layer.
- **Settings come from `.kanbot/project.yml` on the default branch** (agreed before building). It is read with `git show <default>:.kanbot/project.yml`, never from a worktree, so an agent can't widen its own allowlist by editing it, and a post-run check fails any run that changes `.kanbot/`.
- **Post-run checks fail the run; they never revert.** Commits stay on the branch for you to look at. "Rewritten history" is checked as "the pre-run head is an ancestor of the new head", which catches amend, reset and rebase in one test.
- **Bounce rows are narrowed by verdict.** "QA failed" means Testy *reported* `failed`. A QA run that crashed or never reported also ends in state `failed`, and it goes to Blocked like any other broken run rather than bouncing to the developer.
- **The overlap check is a 409, like the cancel confirmation.** No "waiting" flag and no separate `start-anyway` endpoint: the ticket stays in Ready, the board asks, and "Start anyway" resends the move with `startAnyway: true`.
- **Each review replaces the last one's comments.** On every Code Review run, Nancy's earlier comments are marked resolved before her new ones are stored, so "unresolved" always means "from the latest review".
- **Bounced runs start cold** with the review or test report in context, rather than resuming the session. Session resume is verified for M4's needs_input (`resume: sessionId`; sessions are files on the worker's machine).
- **Replay scripts per attempt.** `<scenario>.<n>.json` is the agent's nth run on the ticket, so a scripted bounce is just `bounce.1.json` and `bounce.2.json`. Scripts can carry a git patch that replay commits, so worktrees, diffs and post-run checks are real in tests. Recording writes the same format.
- **Only Ponytail ships** (agreed before building). Its mode reaches the hooks as `PONYTAIL_DEFAULT_MODE`: full for Sir Codes-a-Lot, lite for Plan B, and off for Nancy, who keeps its review skill (a mode would bias her toward approving minimal code). The task-board hooks that write CSVs and call webhooks are not vendored.
- **The sample repo needs no install.** Node 23.6+ runs its TypeScript directly, so worktrees are usable at once and tests stay fast. `.gitattributes` keeps it LF so replay patches apply on Windows checkouts.

### Changes to the spec (`requirements.md`)

Every departure from the spec is edited into the spec itself. This list says where:

| Change | Why | Where in the spec |
| --- | --- | --- |
| **Path fence for every agent tool** (M2 leftover, not on any deferred list). The M2 hook checked tool names only, so Plan B could Read/Grep/Glob any file on the machine. Paths and globs outside `cwd` are now refused, symlinks followed. | Found after M2; it matters more now that agents edit and run commands | §8 step 4, §14 code safety, §16 "Deferred from M2" (new ✓ row) |
| **Ask before re-planning; Approve plan button** (owner review). Moving a planned ticket back to Planning asks whether Plan B should revise it (with a request) or keep the plan; the drawer has Approve plan (→ Ready). Auto-pull from Ready stays in M5 | Re-planning by accident cost a run; approving needed a drag | §3 Planning row and Manual moves, UC-4, §12 move and approve-plan endpoints |
| The hook, not the SDK's allowlist, is the shell fence; `dontAsk` + `blockReadsOutsideWorkingDirectories` as a second layer; subprocess env scrub | SDK auto-approves read-only commands in every mode | §8 step 4, §14 |
| Plan titles are always `Plan: <ticket title>` | v1 had the key, v2 didn't | `agents/plan-b.md` (prompt only) |
| Commands, test globs, hotspots from `.kanbot/project.yml` (default branch); DB columns + Settings → M4 | Agreed before building; onboarding detects commands | §9 hotspots, §11 `projects`, §16 both deferred tables |
| Tool placeholders `{install}` `{build}` `{test}` `{lint}`; `editScope` in frontmatter | Allowlists are per project; Testy's test-files-only rule needs a scope | §8 agent definition, §14 |
| QA success stays in QA flagged `awaiting_approval`; QA `failed` bounces only when reported | Ship has no agent until M4; a crash isn't a bug report | §3 transition table |
| Overlap is a 409 + "Start anyway" on the move; no waiting flag, no `start-anyway` endpoint; overlaps not shown on cards until links (M4) | Same pattern as the cancel confirmation; less state | §3, §9 overlap check, §12 |
| **Post-M3 audit.** The post-run check fails a run only if *its own* commits reached the default branch; the owner may commit there during a run | The old rule blamed the agent for the owner's commits; the `.git` fence rule removes the agent's route to the default branch | §8 post-run checks |
| **Post-M3 audit.** Agents may not edit `.git` | In a worktree `.git` names the repository; rewritten, commits land on the default branch | §14 code and repo safety |
| **Post-M3 audit.** One worker per database (advisory lock); a ticket's next run waits for its aborted run to stop | A second worker marked live runs interrupted; a cancelled agent could still write while the next one took its snapshot | §8 cancellation, crash recovery |
| **Post-M3 audit.** Only localhost Host names and same-origin writes reach the app (`apps/web/proxy.ts`); `defaultBranch` must be a valid branch name | No auth until M4 doesn't stop DNS rebinding or CSRF from a browser tab; a branch named `--output=x` was a git option | §16 auth row |
| Stall repetition ignores repeats separated by a file edit | Real pass 1 stopped Testy re-running tests after fixing his own test | §8 stall detection |
| Blocking cross-ticket risk downgrades `success`; no proposed `blocks` link until M4 | Links need a confirm UI | §9 cross-ticket review |
| Worktree location `<repo>.kanbot-worktrees/<KEY-n>`; created on the first In Progress, Code Review or QA run; removed on delete | §7 said "beside them" without a layout | §14, §8 step 2 |
| Install runs only when a worktree is created (lockfile detection → M4); no rebase before runs (→ M4) | Nothing merges into main locally yet | §8 step 2, §16 "Deferred from M3" |
| Post-run checks: branch, default branch, history rewrite, `.kanbot/`, edit scope | Spec named only test globs and default-branch commits | §8 rules |
| Stall detection: repetition only; the other three rules → M4 | Hard limits already bound every run | §8 stall table |
| Recorded runs are `<agent>/<scenario>.<n>.json` in the replay format, not `<name>.jsonl`; replay falls back to `default.json` | One format to read; scripted bounces | §8 testing |
| Golden tickets: 4 in `fixtures/golden/`; pass = reached QA until Ship exists | PR Review doesn't exist yet | §8 checking agent quality |
| Ponytail only; Nancy's Ponytail is off with the review skill; the other four plugins → M4 | Agreed before building | §8 plugins, Ponytail table, other bundled plugins |
| Playwright-based QA → M4 | Agreed before building; comes with the Playwright plugin | §16 M3 line, "Deferred from M3" |
| Ticket links, WIP limits / auto_advance, per-project concurrency → M4 | Agreed before building | §16 both deferred tables |
| Ship/Done confirmations → M4 | They guard PR actions that arrive with Ship-It and Archie | §16 "Deferred from M1" |
| Diff tab is unified; side-by-side → M5 | Unified is enough to review | §13 drawer, "Deferred from M3" |
| `GET /api/tickets/:id/diff` response shape | Unspecified | §12 |
| `evals/results/` is gitignored; only `evals/baseline.json` is committed | Keep run data out of the repo | §8 checking agent quality |

§16 marks M3 done, updates the M1 and M2 rows M3 handled (✓) or moved, and adds a **"Deferred from M3"** table.

## M4: unblock (local)

### Key decisions

- **A `needs_input` run ends.** Under M3's index, an `awaiting_input` run stayed active, and the one-active-run index then left Duckworth no room to run. Now `awaiting_input` is terminal, like `failed`. It keeps its session ID, and Resume starts a *new* run with `resume_session_id`. If the session file is gone, the run starts cold with the same context.
- **Pause all stops runs at once** rather than "after the current step" (FR-63). Interrupted runs restart by themselves, so nothing is lost. A step boundary isn't observable from the SDK.
- **The worker removes the worktree at Done, not Archie.** It does this before his run starts, so a failed or skipped retro never leaves a worktree behind. Archie only reads.
- **Agent link proposals wait for the owner.** Only confirmed links block, and a blocker is overridable with "Start anyway", like an overlap.
- **The database is the source of project settings.** `.kanbot/project.yml` seeds a project once, on its first read; the file is still read only from the default branch. An empty command from the form is dropped before storing (`""` would fail `projectConfig` and break every read).
- **Costs per ticket: total only.** The per-ticket $3 budget moved to M6 (decided 2026-11-05).
- **Resume at the bounce limit resets the count.** Otherwise the resumed reviewer's next change request would send the ticket straight back to Blocked. It is logged as an `edited` activity, since a new activity enum value would need a migration.
- **The golden bounce comes from a late acceptance criterion.** `eval.ts` adds the review ticket's `reviewCriterion` ("PATCH with a title longer than 100 characters returns 400…") when it first enters Code Review. Bad hints in the description didn't work: in M3 Sir Codes-a-Lot ignored them, and in M4 Plan B rejected them while planning. A late owner *comment* (P6's first try) asked only for what was already built, and Nancy treats comments as background. Criteria she checks.
- **Bundled plugins are switched off by name.** `settings.enabledPlugins` sets the three `@builtin` ids to false; a real session aborted at init then listed only `ponytail`.

### Changes to the spec (`requirements.md`)

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

## M4.5: quality gates and epics (local)

### Key decisions

- **The gate is the worker's, not an agent's.** It costs nothing and is deterministic, and it uses the same commands Sir Codes-a-Lot is already told to run. A second agent re-running them would only repeat Testy. The gate catches what he skipped or got wrong.
- **A gate failure counts as a bounce.** Without that, a build that never passes would loop forever. The bounce limit sends it to Blocked like any other loop.
- **The skill is one file, not the upstream folder.** The permission hook only lets agents read inside their working directory, so Nancy couldn't open companion files under `plugins/`. Widening the fence to plugin folders would loosen the security boundary to save a copy-paste.
  - So `SKILL.md` is a short Kanbot header for diff review, followed by the upstream core principles, anti-patterns, attack classes, and the web and client-side companions, verbatim (`VENDORED.md`).
  - The full audit mode was left out. It needs parallel sub-agents, writes report files outside the repo, and requires an OS sandbox before it runs target code. None of that fits a read-only reviewer.
  - The skill adds about 11k tokens when Nancy runs it.
- **Epics come from the M6 design, pulled forward.** "A doc into tickets" and "split an epic" are the same mechanism. A doc either goes in the description (50,000 characters) or stays in the repo for Plan B to read. That covers the owner's 94 KB spec without new storage.
- **Accepted links are confirmed.** The owner accepted the plan that names each dependency, so asking again would be an extra click per ticket.
- **Proposals live in the plan artifact's `data`, not a new table.** A revised plan carries its own list. `data.accepted` records what was already created, so a ref is never created twice.

### Changes to the spec (`requirements.md`)

- **§3:** two In Progress rows for the checks gate. Manual moves: an epic can't enter a build column (409 `epic`).
- **§4:** Nancy's row names the security skill.
- **§5 UC-11:** now covers a technical doc as input, and describes how acceptance works.
- **§6 FR-23:** checks-gate bounces count toward the limit.
- **§8:**
  - "Run lifecycle" has the checks gate.
  - "Other bundled plugins" has the Security audit row.
  - Golden tickets are five, and new ones aren't compared.
  - The verdict paragraph covers `proposedTickets`.
- **§11:** artifacts row (`data.proposedTickets`, `data.accepted`, the "Kanbot checks" reports).
- **§12:** `POST /api/tickets/:id/accept-proposals`.
- **§13:** the drawer's epic panel.
- **§16:** M4.5 added; the M6 "Epics" row is removed (built).
- **§17 Decided:** the security-audit plugin.
- **Where things stand:** the M4.5 bullet.

### After M4.5: QA checks criteria against a running app (2026-11-05)

Testy no longer reruns the whole suite: the checks gate already ran it before Code Review, and CI reruns it on the PR. QA now answers "does this branch do what the ticket asks?", with evidence per criterion.

- **`start` command** (Settings, `.kanbot/project.yml`). For a QA run the worker starts the app from the worktree on a free `PORT`, waits for any HTTP answer on `/` (60 s), and stops it with its child processes when the run ends (`startApp` in `apps/worker/src/worktree.ts`). An app that won't start goes to Testy as text, not as a run failure.
- **`http_request` tool** on Kanbot's MCP server, only for runs with an app. It reaches only that app: paths, not URLs, no redirects followed (`appRequestUrl` in `fence.ts`). This replaces allowing `curl`, which could reach any host.
- **`<qa_setup>` in the context** tells Testy whether there is a test setup (command and globs) and an app. Without a test setup it doesn't write tests and cites code instead, so a project in a stack the worker can't run still gets a QA pass.
- **Stall detection:** an app request is progress, and a request that changes the app (not GET, HEAD or OPTIONS) resets the repetition count like an edit.
- **The sample repo** has `start: node src/server.ts`.

**Changes to the spec:** §4 Testy's row and "How QA runs" (rewritten); §7 "Project toolchains (required in M5)" and the Isolation note; §8 stall detection rules; §13 Settings; §14 container mode split (project commands in M5, the whole run Later); §16 M5 line and a new first M5 row, the M6 Playwright row; §17 Decided (QA's job, project toolchains); Where things stand.

**Real-agent eval (2026-11-06, $2.62):** all five golden tickets reached Done within the baseline's bounces and cost (the result file is under the git-ignored `evals/results/`; `evals/baseline.json` was re-saved from this run). Testy's five QA runs cost $0.06–0.08 each and passed every ticket. Four of them exercised the app with `http_request` (2 to 7 requests each). The bug-fix run also wrote a test. The `security` run (bold text in titles) made 2 tool calls and no app requests, so it judged that ticket from the code.

**Risk:** the app runs in the worktree, so an app that writes files into the repository (a data file that isn't ignored) makes the QA run fail the edit-scope check. §4 says so.

### After M4.5: UI revamp (2026-11-06)

A visual pass over the board and the drawer, plus a record of which agent changed what.

- **Themes:** light and dark, the OS setting by default, a toggle in the top bar, on Home and in Settings, remembered per browser (`theme-toggle.tsx`). Design tokens (slate and indigo, status colors) live in `apps/web/app/globals.css`; fonts are Plus Jakarta Sans and JetBrains Mono. `brand.tsx` holds the wordmark, and the home page moved into `home.tsx`.
- **Agent colors:** agent frontmatter has an optional `color` (`packages/shared/src/agents.ts`; default slate). It marks the agent's column stripe, its cards' left stripe and its glyph avatar. A gate column is dashed and says "You decide".
- **The ticket drawer is a centered dialog** (`ui/dialog.tsx`; `ui/sheet.tsx` removed), up to 85% of the screen height and scrolling inside.
- **Who changed what:** `runs.files_changed` (migration 0009) holds the files a run itself changed in the worktree, committed or not, excluding files an earlier run left dirty. The worker records it even when the post-run checks fail (`apps/worker/src/run.ts`). `getDiff` in `apps/web/lib/tickets.ts` uses it to name the agents above each file in the Diff tab, and `getTicket` joins each artifact to the agent whose run produced it.

**Changes to the spec:** Where things stand; §8 agent frontmatter (`color`); §11 `runs.files_changed`; §13 Board, Ticket drawer and General; §16, where the "Dark theme" row is gone from "Still to build".

**Checked:** the owner checked the revamped UI in a real browser. The Testy eval in the section above passed.

## M5: ship and deploy (closed 2026-11-10)

*Done when:* a ticket goes from Backlog to a human-approved, merged PR. Met on 2026-11-07 on Neural-Noir-Website (NNWEB-3 and NNWEB-4). Phases 5c (keeping branches current) and 6 (leftovers) moved to M6 on 2026-11-10.

### Key decisions

- **Owner decisions at the start (2026-11-06).**
  - Rootless Docker, with the plain `docker` CLI and no socket proxy.
  - No Droplet or domain: Kanbot runs on the owner's PC in its own WSL distro. A paid Droplet was more than the owner wanted, and nothing in "done when" needs a public server. A public server is optional and moved to M6.
  - Onboarding steps 8–9 (hotspot groups, a drafted CLAUDE.md as a PR) moved to M6.
- **Polling, not webhooks.** GitHub can't reach a PC behind NAT. One poll reads each watched PR, its head's check runs and its reviews: three calls per ticket per minute, far below the App's limit. Webhooks come with a public server (M6).
- **GitHub's moves are data like the run rules** (`GITHUB_RULES`, `afterGitHub()`), and the watcher reuses `finish()`'s move-and-start, so a CI bounce resumes Sir Codes-a-Lot's session and the bounce limit sends it to Blocked like any other bounce.
- **GitHub first, then one transaction that re-checks the ticket.** Nothing is locked while GitHub answers; if the owner moved the ticket meanwhile, the tick skips it and the next one sees it fresh.
- **Only Ship (after the push) and PR Review are watched.** Requested changes are imported only from PR Review (`last_review_id` marks what's handled), as the owner's comments, so Sir Codes-a-Lot's context already carries them.
- **The owner's pushes: fast-forward only** (FR-48). A diverged branch stops the run with a clear message instead of a merge commit or a rebase.
- **Project commands run in the project's own image**, one `docker run` per command with a shared cache volume.
  - No image means the host toolchain, in development only; a containerized worker always has one (`KANBOT_DEFAULT_IMAGE` last).
  - The image is read only from the database, so an agent can't change its own sandbox. Kanbot's code detects it and builds it from the devcontainer's Dockerfile (not a root `Dockerfile`, which is usually the production image) via `git archive` of the default branch, tagged by tree hash. Images are built on the server, with no registry.
  - The fence checks the agent's command first and rewrites second, so the fence's rules are unchanged.
- **A dedicated WSL distro**, with automount and interop off, so an escaped project container can't reach Windows files. The worker runs as root inside its container, which under rootless Docker is the host's unprivileged user; the SDK runs in `dontAsk` mode, which doesn't refuse root.
- **Login without a session table.** One owner, one cookie: a signed id and an expiry, checked by the proxy with no database call. The owner is whoever created the GitHub App. Plain `fetch` and `node:crypto`, no Octokit. URLs come from the browser's Host header, because Next names its bind host.
- **Onboarding's GitHub calls are the web app's, git is the worker's.** Detection is Kanbot's code, not an agent's. Baseline failures are skipped by the checks gate, not compared (a new break in an already-failing command is caught by review, QA and CI). The starter workflow runs in the project's image. Branch protection binds admins and never overwrites rules already there; it is checked at setup only.
- **QA's browser is Kanbot's own five tools on `playwright-core`, not the Playwright plugin**: the plugin has about 25 tools, so fencing it would take a URL check per tool. Every request is fenced in one place (the browser context's routing). Screenshots live in Postgres (`bytea`), so they go with the ticket.
- **The backup is a host cron job, not a service**, and deploys build on the server after CI.

### Changes to the spec (`requirements.md`)

- **§3:** GitHub's rows (`GITHUB_RULES`); Ship's `success` keeps the ticket in Ship flagged `pr_open`; merged and closed apply from Ship; a closed PR's worktree is removed. Manual moves gained `skip_gates`, `no_pr`, `pr_open`, `unprotected`, `qa_setup`.
- **§4:** Ship-It writes and the worker opens the PR; "How QA runs" (the app in the image, the browser and its fence, screenshots, a start command required, a forwarder container for any port).
- **§7:** "Project toolchains" and "Deployment" (containers, profiles, rootless Docker, backups, the nightly cleanup, WSL and server setups).
- **§8:** the checks gate skips commands that failed at baseline; stall rules count browser calls; the Playwright plugin isn't used; CI enforces the eval rule.
- **§10:** onboarding as built (steps 1–7 and 10), the two-click GitHub App setup, project env vars, what counts as CI. The Merge button and the "small fix" checkbox moved to M6.
- **§11:** `settings.github_app`, `projects.onboarding`, `projects.env`, `image`, `dockerfile`, `screenshots`; `tickets.ci_state`, `review_state`, `last_review_id`; new `activity` actions.
- **§12:** auth on every route; the GitHub, onboarding and `approve-ship` endpoints; `POST /api/tickets/:id/move` answers `run_active` before closing an open PR.
- **§14:** agent and host project-command environments lose Kanbot's own credentials; commands run in the project's image.
- **§16:** M5 rows moved off or to M6; "Where things stand" rewritten.

### Known limits carried over

- Detection covers Node, Python and Go at the repo root. A repo whose workflows never report a check on the ticket's branch leaves the ticket in Ship (drag it on). The CI log tail comes only from GitHub Actions.
- A GitHub App is tied to the address it was created from; a second address needs a callback URL added on GitHub.
- A move to Done closes the PR before the move's transaction; if the move then fails, the PR is closed and the ticket stays put. The bot identity is looked up once per worker process.
- Settings are seeded once from the default branch; a devcontainer added later needs Image set by hand. Devcontainer `features`, `postCreateCommand` and docker-compose devcontainers aren't applied.
- Python `pip install --user` packages share one cache volume across projects. The images are about 2.9 GB each. Docker Desktop sometimes fails to unpack a first pull; a retry works.
- Project env vars can't hold multi-line values and aren't pushed to Actions secrets (owner's choice).
- The eval doesn't run Ship-It: its golden tickets use local projects, where Ship stays a gate. Needs a stub-backed GitHub project in the eval, a paid run with the owner's OK.
- NetGPT is a desktop app, so its QA can't pass until Kanbot can drive non-web projects (an M6 row).
- The logon task that keeps the WSL distro running is documented but untested, and rootless Docker's host network in the owner's `kanbot` distro was never checked for real.
