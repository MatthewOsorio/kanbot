# Kanbot — Technical Requirements

Last updated 2026-11-10 (M5 closed; its unfinished rows moved to M6).

## Where things stand

- **Built (M1–M5, plus work since):**
  - The board: projects, tickets, criteria, comments, activity, drag and drop, live updates over SSE.
  - The worker: a runs-table queue, the Claude Agent SDK runtime behind a permission-hook fence, and a replay runtime for tests.
  - Four agents work the build loop:
    - Plan B (Planning);
    - Sir Codes-a-Lot (In Progress), in a worktree per ticket;
    - Nitpick Nancy (Code Review), with cross-ticket review;
    - Testy McTestface (QA), who checks each criterion against the app the worker starts, over HTTP and in a headless browser (screenshots on the ticket), with tests where the project has a test setup.
  - Bounce-backs and the bounce limit, the overlap check, stall detection, Ponytail, and the golden-ticket eval.
  - Unblocking (M4): Blocked with Rubber Duckworth, Resume with an answer, session resume on bounce-backs, in-app notifications; the daily cap, Pause all and automatic resume after an outage; Archie's retro and worktree removal at Done; ticket links; project Settings; the cost total on each ticket; CI.
  - Ship and deploy (M5, closed 2026-11-10): project commands, the QA app and agents' project commands run in each project's own container image (§7); the GitHub App's two-click setup and Sign in with GitHub on every route (§10, §12); onboarding a GitHub repo, with agents off until branch protection is applied or overridden (§10); QA needs a start command; project env vars, encrypted; the nightly cleanup; Captain Ship-It writes the PR description and the worker opens the PR (FR-43); Testy checks the app in headless Chromium, with screenshots on the ticket (§4); a 60 s poll moves tickets on CI, reviews, merges and closes (FR-44 to FR-48). Kanbot runs on the owner's PC in its own WSL distro; a public server is optional and later.
  - Quality gates and epics (M4.5): the worker's checks gate (build, lint and test after every build run, before Code Review); Nancy's security pass with Cloudflare's security-audit skill; epics, where Plan B splits a ticket or a technical doc into proposed tickets the owner accepts into Backlog.
  - The UI revamp (after M4.5): light and dark themes with a toggle, slate and indigo design tokens, Plus Jakarta Sans and JetBrains Mono, and agent colors: each agent file names a color, which marks its column, its cards and its glyph avatar. The ticket drawer is a centered dialog, and its artifacts and diff files name the agent that made them (`runs.files_changed`).
- **How it runs:** locally only, bound to 127.0.0.1, behind Sign in with GitHub (the owner only). Tested on Windows only. Project commands, image, env vars, test globs, hotspots, bounce limit and concurrency are edited in Settings, seeded once from `.kanbot/project.yml`.
- **M6 (started 2026-11-10).** Phase 1 is built: branches are kept current (rebase before each run and when main moves, FR-51, FR-48) and `/api/health` reports GitHub. Next are the leftovers in §16.

The rest of this document is the target design. Anything not built yet is listed in §16 "Still to build", with the milestone that builds it.

## 1. Overview

Kanbot is a self-hosted Kanban board where moving a ticket into a column starts the AI agent that owns that column. A ticket travels Backlog → Planning → Ready → In Progress → Code Review → QA → Ship → PR Review → Done, and each working stage is worked by a named agent that writes its results back onto the ticket. The human stays in charge of the gates: approving plans, answering questions and merging code.

"Kanbot" is a working title.

### Goals

- Turn a one-line idea into a planned, built, reviewed and tested pull request with as little hand-holding as possible.
- Make every agent's work visible: live logs, diffs, test reports and costs on the ticket.
- Keep the human as the approver at the points that matter (plan sign-off, unblocking, merge).
- Make agents configurable as files (prompt, model, tools, budget) so new agents and columns are cheap to add.
- Be fun to use: each agent has a name, an avatar and a bit of personality in its status messages.

### Non-goals (v1)

- Multi-user teams, permissions and real-time collaboration between people.
- Replacing Jira for human teams; this is a personal AI-development cockpit.
- Hosting as SaaS for other people. It runs on the owner's own machine (WSL), or optionally the owner's own server.
- Supporting non-git projects.

### Primary user

A single developer (the owner) who builds side projects and tools with AI coding agents, works in git, already uses Claude Code with worktrees, and wants a structured pipeline instead of juggling terminal sessions.

## 2. Core concepts

Six nouns carry the whole system: a project holds tickets, tickets sit in columns, columns own agents, and agents do their work as runs that produce artifacts.

| Term | Meaning |
| --- | --- |
| Project | One GitHub repository, cloned onto the server, plus its settings: default branch, commands, QA settings, hotspots, budgets. |
| Ticket | A unit of work: feature, bug, chore, spike or epic. Has a description, acceptance criteria, priority, branch and history. Key format `PROJ-123`. |
| Column | A stage in the workflow. A column may own one agent, or none (a human gate). Columns and their order become configurable per project later (FR-4). |
| Agent | A named AI worker defined by a config file: system prompt, model, allowed tools, limits, and the column it serves. |
| Run | One execution of an agent against one ticket. Has a state, a streamed event log, token and dollar cost, and a final verdict. |
| Verdict | The structured result every run must end with: `success`, `changes_requested`, `failed` or `needs_input`, plus a summary. The orchestrator moves the ticket based on it. |
| Artifact | Something a run produces and attaches to the ticket: plan, review notes, diff, test report, PR link, retro. |
| Worktree | An isolated git worktree and branch (`kanbot/PROJ-123-short-slug`) created per ticket so agents never touch the main checkout. |
| Gate | A column with no agent where the ticket waits for a human decision (e.g. Ready). |
| Bounce-back | An automatic move backwards, e.g. Code Review sending a ticket back to In Progress with change requests. |

## 3. Board workflow

Ten columns form the default workflow: seven have an agent and three are human gates; Blocked is the agent column that waits on the human's answer.

Backlog → Planning → Ready → In Progress → Code Review → QA / Testing → Ship → PR Review → Done, plus Blocked beside them. Backlog, Ready and PR Review are the human gates.

Work snakes from Backlog to Done; Code Review, QA, CI and your PR review can all bounce a ticket back to In Progress, and any agent can send it to Blocked.

### Transition table

The orchestrator applies these rules after every verdict; the human can still drag any ticket to any column, which cancels an active run and starts the target column's agent. The rules are data in `packages/shared/src/transitions.ts`; each milestone wires the rows for the agents it ships. A column whose agent file isn't in `agents/` yet behaves as a gate: no run starts there.

| From | Event | To | Automatic? |
| --- | --- | --- | --- |
| Backlog | User drags | Planning (starts Plan B, or Dr. Rabbit Hole for spikes) | No |
| Planning | `success` | Stays in Planning, flagged "Plan ready" | Yes |
| Planning | User approves (drags to Ready, or clicks Approve plan on the ticket) | Ready | No (configurable) |
| Ready | User drags, or auto-pull with a free WIP slot | In Progress (creates worktree, starts Sir Codes-a-Lot) | No by default |
| Ready | Overlaps an in-flight ticket, or has an unfinished confirmed blocker (section 9) | The move is refused (409 `overlap`) and the ticket stays in Ready; the owner is asked to "Start anyway". | Yes; user can "Start anyway" |
| In Progress | `success`, and the checks gate passes (section 8) | Code Review | Yes |
| In Progress | `success`, but the checks gate fails | Stays in In Progress; Sir Codes-a-Lot runs again (resuming his session) with the failing output as a test report, bounce +1 | Yes |
| Code Review | `success` | QA / Testing | Yes |
| Code Review | `success`, but the project has no start command, so QA can't run the app | Stays in Code Review, flagged `needs_input`, with the reason in its activity; the owner sets a command in Settings and drags it to QA | No |
| Code Review | `changes_requested` | In Progress, review comments attached, bounce +1 | Yes |
| QA / Testing | `success` | Stays in QA, flagged `awaiting_approval`; dragging to Ship, or "Approve and ship" on the ticket, is the approval | Approval gate by default |
| QA / Testing | `failed` reported by Testy | In Progress, test report attached, bounce +1. A QA run that fails without reporting (crash, max turns) goes to Blocked like any other | Yes |
| Ship | Captain Ship-It reports `success` and the checks pass | Stays in Ship, flagged `pr_open`: the worker pushed the branch and opened (or updated) the PR, and the ticket waits for CI | Yes |
| Ship | The checks fail after Ship-It's edits | In Progress, the checks report attached, bounce +1 | Yes |
| Ship | PR opened and CI green, or the repo has no CI workflows | PR Review; "PR ready for your review" notification | Yes |
| Ship or PR Review | CI fails | In Progress, failing log attached, bounce +1 | Yes |
| PR Review | Human requests changes | In Progress with the review comments (not counted toward the bounce limit) | Yes |
| Ship or PR Review | Human merges | Done (starts Archie) | Yes |
| Ship or PR Review | PR closed without merging | Backlog; worktree removed, branch kept | Yes |
| Any column with a branch | Main moved and the rebase conflicts | Stays put while Marge Conflict resolves; on success goes to Code Review | Yes |
| Any agent column | `needs_input`, `failed`, `timed_out`, `budget_exceeded`, or bounce limit reached | Blocked (starts Rubber Duckworth) | Yes |
| Blocked | User answers and clicks Resume | The column the ticket came from; that agent resumes its session | No |

GitHub's rows (CI, reviews, merges, closes) are data too, `GITHUB_RULES` in `transitions.ts`, applied by the worker's 60 s poll (`apps/worker/src/watch.ts`). Only tickets in Ship (once Ship-It pushed, flag `pr_open`) and PR Review are watched. A PR merged or closed while its ticket is elsewhere is noticed when the ticket gets back to Ship, whose push reopens a closed PR. A bounce from CI resumes Sir Codes-a-Lot's last session, like the other bounces.

### Manual moves

Dragging a ticket yourself always works and always triggers the target column's behavior; dropping it on a gate counts as your approval of that gate.

| You move a ticket to | What happens |
| --- | --- |
| Backlog | Any active run is cancelled; worktree and branch are kept; no agent runs. |
| Planning | Plan B runs. If a plan exists, you are asked first (409 `has_plan`): keep it (the ticket shows Plan ready and nothing runs) or say what to change, and Plan B revises it using the current branch diff, your comments (as background) and your change request. Bounce count resets. |
| Ready | No agent; counts as approving the plan. |
| In Progress | Sir Codes-a-Lot runs; a worktree is created if missing. |
| Code Review | Nitpick Nancy reviews the branch as it stands, including commits you made yourself. |
| QA / Testing | Testy McTestface runs against the branch as it stands. |
| Ship | Counts as ship approval; Captain Ship-It opens or updates the PR. Skipping Code Review or QA asks you to confirm first (409 `skip_gates`, unless the ticket comes from QA flagged `awaiting_approval`, or from PR Review). On a local-folder project (no GitHub) Ship stays a gate: nothing runs. |
| PR Review | If a PR exists, the ticket waits for your review; if not, you're asked whether to run Ship first (409 `no_pr`; the board offers to move it to Ship). |
| Done | If the PR is merged or closed, Archie runs. If it is still open, you confirm closing without merging (409 `pr_open`); the web app closes the PR on GitHub, the branch is kept, and Archie runs. A ticket with no PR goes straight to Done: the worker removes the worktree and Archie runs at once. However his run ends, the ticket stays in Done (a failed retro shows Failed with Retry). |
| Blocked | Rubber Duckworth summarizes where things stand, so a parked ticket keeps its context. |

An epic is planned, never built: moving it into In Progress, Code Review, QA, Ship or PR Review is refused (409 `epic`). Its accepted tickets are built instead (UC-11).

Moving a ticket with an active run cancels that run first (FR-24). No manual move merges code; merging always goes through GitHub's protected path.

## 4. Agent roster

Nine agents ship in v1: one per working column, plus a researcher, an unblocker and a conflict mediator; each is a config file the user can edit, rename or replace.

| Agent | Column | Job | Tool access | Produces |
| --- | --- | --- | --- | --- |
| **Plan B** — "Always has a backup plan." | Planning | Turns a rough idea into a spec: problem statement, acceptance criteria, implementation plan, files likely touched (the touch set), risks, size estimate. Flags related or dependent tickets. Splits epics into child tickets. | Read-only repo (read, search, list). No edits, no shell. | Plan artifact (markdown), acceptance-criteria checklist, touch set, proposed links and child tickets |
| **Dr. Rabbit Hole** — "Went looking for one answer, came back with twelve." | Planning (spike tickets only) | Researches a question: compares libraries, reads docs, prototypes in a scratch dir. Answers with a recommendation. | Read-only repo, web search/fetch, write only inside a scratch folder. | Research report with recommendation and sources |
| **Sir Codes-a-Lot** — "Knighted for services to the keyboard." | In Progress | Implements the approved plan in the ticket's worktree; writes unit tests; runs build, lint and tests; commits in small steps. On bounce-back, addresses review comments, bug reports, CI failures or the human's PR review. | Full edit in worktree, shell (allowlisted commands), git commit (no push). | Commits on the ticket branch, implementation notes |
| **Nitpick Nancy** — "Has opinions about your semicolons." | Code Review | Reviews the branch diff against the plan and acceptance criteria: correctness, readability, security (with the security-audit skill, section 8), missing tests, scope creep, and changes that would break other in-flight tickets (section 9). | Read-only repo, git diff/log, can run linters. No edits. | Review artifact with line comments; verdict approve or changes requested |
| **Testy McTestface** — "Breaks things professionally." | QA / Testing | Checks that the branch meets each acceptance criterion, with evidence: exercises the app the worker started, writes a test per criterion when the project has a test setup; cites code only for criteria about the code itself. Leaves regressions to the checks gate and CI. | Edit test files only (enforced by path globs), the project's test command, HTTP and a headless browser to the running app only. | Test report: pass/fail per criterion, bug reports with repro steps |
| **Rubber Duckworth** — "Quack. Tell me where it hurts." | Blocked | Summarizes why a ticket is stuck, what was tried, and the exact questions the human must answer. Suggests options. | Read-only ticket history and repo. | Blocker summary with numbered questions |
| **Captain Ship-It** — "Fortune favors the merged." | Ship | Writes the PR description and changelog entry and updates docs/README if needed. Then the worker (not the agent) re-runs the checks, pushes the ticket branch and opens or updates the PR with the App's token, and the ticket waits for CI. | Edit Markdown files and `docs/` only (`editScope: docs`), local git commits. No GitHub token and no push: the worker does those (owner's choice, 2026-11-07). Never pushes to or merges into the default branch. | PR description artifact (`pr_description`), changelog entry, the PR link on the ticket |
| **Archie the Archivist** — "Remembers everything so you don't have to." | Done | Writes a short retro (what was built, cost, bounce-backs, lessons), suggests additions to the project's CLAUDE.md. | Read ticket history and the repo. The worker, not Archie, removes the worktree (FR-49), before his run starts. | Retro artifact, CLAUDE.md suggestions |
| **Marge Conflict** — "Nobody leaves until we all get along." | None: triggered when a rebase onto main conflicts (section 9) | Resolves merge conflicts using both tickets' plans and acceptance criteria, then re-runs build and tests. | Edit conflicted files only, shell (allowlisted), git commit (no push). | Resolution commit and notes, or conflict hunks for the human |

Backlog, Ready and PR Review have no agent; tickets there wait for the human.

### Agent personality rules

- Personality lives in the UI only: the name, avatar, tagline and templated status lines ("Nitpick Nancy found 4 things to nitpick"). It is not injected into working prompts, so it never degrades output quality.
- A per-user "serious mode" toggle swaps the funny status lines for plain ones.

### Default models

Each agent's model is set in its frontmatter. These are starting defaults, to be tuned once cost data comes in: the strongest model where mistakes are expensive, cheaper ones for well-scoped or summarizing work.

| Agent | Model | Why |
| --- | --- | --- |
| Plan B | Claude Opus 5.5 (`claude-opus-5-5`) | A good plan saves whole build-and-bounce cycles; planning reads a lot but writes little. |
| Sir Codes-a-Lot | Claude Opus 5.5 | Does the most consequential work; its mistakes cost the most to catch later. |
| Marge Conflict | Claude Opus 5.5 | Has to reconcile two tickets' intents correctly. |
| Nitpick Nancy | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | Strong reviewer at lower cost; a different model from the coder adds a second perspective. |
| Testy McTestface | Claude Sonnet 5.5 | Writing and running tests is well scoped. |
| Captain Ship-It | Claude Sonnet 5.5 | Mostly mechanical: PR text, changelog, docs. |
| Dr. Rabbit Hole | Claude Sonnet 5.5 | Research and comparison; can be upgraded per ticket. |
| Rubber Duckworth | Claude Haiku 5.5 (`claude-haiku-5-5`) | Summarizes history and asks questions. |
| Archie the Archivist | Claude Haiku 5.5 | Short retros and cleanup. |

The ticket drawer offers a one-run model override for hard tickets.

### How QA runs

QA answers one question: does the branch do what the ticket asks? Regressions are not Testy's job: the checks gate (section 8) already ran the project's build, lint and test commands before Code Review, and CI reruns them on the PR. Testy checks each ticket in three steps:

1. **Start the app.** If the project has a `start` command (Settings), the worker runs it from the worktree with a free port in `PORT`, waits until `http://127.0.0.1:PORT/` answers, and stops it (with its child processes) when the run ends, however it ends. An app that doesn't come up within 60 seconds is not a run failure: its output goes to Testy, who reports `failed` if this branch broke it and `needs_input` otherwise.
2. **Check each acceptance criterion, with evidence.** Against the running app, through an `http_request` tool and a headless browser that reach only that app (paths, not URLs; the worker refuses any other host). Criteria about what a user sees or does (layout, visibility at a screen size, buttons, forms, console errors) pass only on rendered evidence: the browser or a browser test. The owner's own observation, given as an answer while the ticket was Blocked, counts as evidence too. With a test, when the project has a test command and test globs: one per criterion in the project's own framework, committed to the branch so CI reruns it from then on. Citing code counts only for criteria about the code itself: a behavior passes on evidence from running the app or a test, and when Testy can't run either it reports `needs_input`. The context's `<qa_setup>` section tells Testy which it has. **QA needs a start command** (owner's choice, 2026-11-07, after a NetGPT ticket passed QA on a code read alone): QA's job is to run the app, so a test setup alone isn't enough. Without one, a move into QA is refused (409 `qa_setup`), Code Review's success holds the ticket in Code Review (section 3), and onboarding's commands step doesn't move on (section 10). A project with no repository (tests) is exempt. The worker waits for the app to answer HTTP; a desktop app (e.g. tkinter) never does, so its QA runs report that the app failed to start until desktop apps can be driven.
3. **Report** pass or fail per criterion with its evidence (the request and response, the test, or file:line), and bug reports with repro steps.

Built: steps 1 to 3, over HTTP and in a browser. With a project image (section 7) the app runs in a container, reached through a forwarder published on 127.0.0.1 only, on whatever port and host it listens on (below); without one it runs on the worker's own toolchain. Projects without a UI skip the browser.

**QA's browser** (M5, 2026-11-07, after a NNWEB ticket blocked on "visible without scrolling at <768px and desktop"). Kanbot's own tools on its in-process MCP server, built on `playwright-core` (the version e2e already pins), not the Playwright plugin (section 8): `browser_open` (a path at a viewport size; returns the visible text), `browser_read` (the accessibility tree; for a selector, its box and whether it is fully visible without scrolling), `browser_click`, `browser_type`, and `browser_screenshot` (Testy sees the image, and it is stored on the ticket). Every result lists the console errors and uncaught page errors since the last call. Chromium's headless shell starts on the first call and closes when the run ends.

- **The fence is in the tool,** not only in the permission hook: the browser context aborts every request that isn't on the app's origin (navigations, link clicks, redirects, subresources, the page's own fetch and XHR, popups), refuses WebSockets to any other host, and blocks service workers, which would bypass that routing. The agent is told what was blocked. `browser_open` takes paths through the same check as `http_request`. There is no tool that runs arbitrary JavaScript.
- **Screenshots** are PNGs in the `screenshots` table (section 11), shown as thumbnails under the test report of the run that took them in the drawer's Artifacts tab; each opens full size (`GET /api/screenshots/:id`). They are deleted with their ticket.
- Chromium runs in the worker's process tree, without its own sandbox (a `shortcut:`), like the agents themselves (section 17, container isolation).

- QA settings per project (app start command, ready URL, required services such as a test database) are detected during onboarding. Today onboarding proposes the start command (a Node project's `start` script, else its `dev` script), which is also set in Settings or `.kanbot/project.yml`, and readiness is any HTTP answer on `/`.
- The worker gives each QA run its own free port through a `PORT` environment variable, so two tickets' apps never collide. The app doesn't have to use it: the start command is the one a person runs (`npm run dev`), and in the project's image the app may listen on any port and any host, localhost included. A forwarder container (`alpine/socat`, pinned) owns the app's network namespace, published on 127.0.0.1 only; the app's container joins it, the worker reads the namespace's listening ports (`/proc/net/tcp`, `tcp6`), picks `PORT` if it listens there, else the lowest other port, and the forwarder relays to it from inside. Each app has its own namespace, so ports never collide. Without an image (dev only) the app must listen on `PORT`. The start command may also say `$PORT` (the only `$` a project command may contain), which the worker fills in. Onboarding proposes a Node project's `start` script, else its `dev` script.
- The app runs in the ticket's worktree, so files it writes there count as the QA run's changes and fail the post-run edit-scope check. Apps that keep data should write it outside the repository or to an ignored path.
- The worker image includes Chromium's headless shell and its system libraries (built, M5).
- Later (section 16): if a project has no Playwright setup, onboarding adds it through a PR, so Testy can commit browser tests; Testy only edits test files. The starter CI workflow runs them too.

## 5. Use cases

Fourteen use cases define v1; UC-1 through UC-9 are the happy path and its loops, UC-10 through UC-14 are the edges the system must handle cleanly.

| ID | Use case | Trigger | Expected outcome |
| --- | --- | --- | --- |
| UC-1 | Capture an idea | User types a one-line idea in a quick-add box (or via CLI/API). | Ticket created in Backlog with type and priority defaults. No agent runs. |
| UC-2 | Plan a feature | User drags a ticket from Backlog to Planning. | Plan B writes a plan and acceptance criteria. Ticket shows "Plan ready — awaiting approval". |
| UC-3 | Revise a plan | User types what to change under the plan ("use SQLite, not Postgres") and clicks Revise plan. | Plan B re-runs at once with that request as its instruction and produces plan v2; v1 is kept in history. Comments are separate: general notes (later @mentions) that Plan B reads as background, and they never start a run. |
| UC-4 | Approve and build | User clicks Approve plan on the ticket (or drags it to Ready), then drags it to In Progress (or enables auto-pull from Ready). | Worktree and branch created; Sir Codes-a-Lot implements and commits; on success the ticket auto-moves to Code Review. |
| UC-5 | Review requests changes | Nitpick Nancy returns `changes_requested`. | Ticket bounces to In Progress with review comments attached; Sir Codes-a-Lot runs again with them as input. |
| UC-6 | QA finds a bug | Testy McTestface returns `failed` with a bug report. | Ticket bounces to In Progress with the bug report; after the fix it goes through Code Review and QA again. |
| UC-7 | Agent needs input | Any agent returns `needs_input`, or the bounce-back limit is hit. | Ticket moves to Blocked; Rubber Duckworth posts numbered questions; user gets a notification. User types an answer in the Blocked panel and clicks Resume; the ticket returns to its previous column and the agent resumes its session with the answer. |
| UC-8 | Watch an agent work | User opens a ticket with an active run. | Live stream of the agent's messages, tool calls and command output; elapsed time and running cost shown. |
| UC-9 | Ship and close | QA passes; user approves Ship (or auto-ship is on). | Captain Ship-It opens a PR; once CI is green the ticket waits in PR Review. When the owner approves and merges, the ticket moves to Done; Archie writes the retro; the worker removes the worktree. |
| UC-10 | Research spike | User creates a ticket of type `spike` and moves it to Planning. | Dr. Rabbit Hole runs instead of Plan B and returns a recommendation; the user can convert it into feature tickets. |
| UC-11 | Break down an epic, or turn a technical doc into tickets | User creates a ticket of type `epic` whose description is the work (a feature list, or a doc pasted in up to 50,000 characters), or names a doc in the repo ("Plan from `docs/spec.md` §4"), and moves it to Planning. | Plan B writes an overview plan and proposes up to 30 tickets in build order, each with criteria, a touch set and `blockedBy` refs. User accepts some or all in the drawer; each accepted one is created in Backlog as the epic's child, with its criteria, touch set and confirmed `blocks` links to the accepted tickets it depends on. The epic card shows child progress (`2/5 done`). |
| UC-12 | Cancel or redirect | User drags a ticket out of a column while its agent is running. | Confirm dialog; on confirm the run is cancelled, partial commits stay on the branch, and the ticket lands where it was dropped (starting that column's agent if any). |
| UC-13 | Budget exceeded | A run passes its per-run or daily dollar cap. | Run is stopped with state `budget_exceeded`; ticket moves to Blocked with the cost so far; user can raise the cap and resume. |
| UC-14 | Customize an agent | User edits an agent on the Agents page (prompt, model, tools, limits) or adds a new column with a new agent. | Config file saved and versioned; next runs use it; past runs record which version they used. |

## 6. Functional requirements

Requirements marked MVP must ship in the first usable version; Later items are designed for but can wait.

### Projects

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-1 | Create a project by picking a GitHub repo; Kanbot clones it onto the server and validates the default branch. | MVP |
| FR-2 | Project settings: key prefix (e.g. `KB`), default branch, install/build/test/lint commands, test-file globs, hotspot groups, budgets, concurrency limit. | MVP |
| FR-3 | Required GitHub link: owner/repo plus the Kanbot GitHub App installation (section 10) for pushing branches, opening PRs and reading checks and reviews. | MVP |
| FR-4 | Per-project workflow: add, remove, rename and reorder columns and assign an agent to each. | Later |

### Tickets

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-10 | Create, edit, delete tickets with title, description (markdown), type (feature, bug, chore, spike, epic), priority (P0–P3), labels. | MVP |
| FR-11 | Acceptance criteria as a checklist that agents read and QA checks off. | MVP |
| FR-12 | Comments thread on each ticket, written by the user or by agents (agent comments show the agent avatar). | MVP |
| FR-13 | Full activity timeline: every move, run, verdict, comment and artifact, with timestamps and actor. | MVP |
| FR-14 | Parent/child links (epic → children) and "blocked by" dependencies; a ticket blocked by an unfinished ticket cannot enter In Progress unless the owner chooses "Start anyway" (409 `overlap`, like an overlap). Only confirmed links block; an agent's proposal waits for the owner. | MVP |
| FR-15 | Quick-add from anywhere (keyboard shortcut) and from a CLI command `kanbot add "idea"`. | Later |

### Board and transitions

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-20 | Drag-and-drop board with columns, card counts and WIP limits per column. | MVP |
| FR-21 | Moving a ticket into a column with an agent enqueues a run for that agent. | MVP |
| FR-22 | Agent verdicts drive automatic moves per the transition table (section 3). Each auto-move can be switched to "stay and wait for approval" per column. | MVP |
| FR-23 | Bounce-back limit per ticket (default 3, per project in Settings; combined checks-gate, Code Review, QA and CI bounces; the owner's own PR review requests don't count); exceeding it moves the ticket to Blocked. | MVP |
| FR-24 | Moving a ticket with an active run asks for confirmation and cancels the run. | MVP |
| FR-25 | Auto-pull: when In Progress has a free WIP slot, the highest-priority Ready ticket starts automatically (off by default). | Later |
| FR-26 | Filters and search: by type, priority, label, agent, state ("needs me", "running", "failed"). | Later |

### Agents and runs

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-30 | Agents defined as markdown files with YAML frontmatter (section 8), including bundled plugins and skills such as Ponytail, read from disk at the start of every run, so an edit applies to the next run without a restart. | MVP |
| FR-31 | Agents page lists the roster with avatar, tagline, column, model and recent stats; config editable in the UI. | Later |
| FR-32 | Each run gets a context bundle: ticket, acceptance criteria, latest plan, prior run summaries, open review comments or bug reports, and the project's CLAUDE.md. Nitpick Nancy also gets the plans and capped diffs of other in-flight tickets. | MVP |
| FR-33 | Each run must finish by calling a `report_result` tool with a structured verdict; a run that ends without one is treated as `failed`. | MVP |
| FR-34 | Live streaming of run events (assistant text, tool calls, tool results, command output) to the UI. | MVP |
| FR-35 | Runs can be cancelled, retried and resumed (resume continues the same agent session with the user's answer). | MVP |
| FR-36 | Per-run limits: max turns, wall-clock timeout, dollar budget. | MVP |
| FR-37 | Agent config is versioned; each run stores the config hash it used. | Later |
| FR-38 | Pluggable agent runtime (adapter interface) with the SDK adapter and a replay adapter for tests (section 8); other providers or the Claude Code CLI can be added later. | MVP |

### Git, GitHub and overlap

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-40 | Create a git worktree and branch per ticket on first entry to In Progress; reuse it on later runs. | MVP |
| FR-41 | Diff viewer for the ticket branch vs the default branch. | MVP |
| FR-42 | Bot identity via the Kanbot GitHub App, created from a manifest in two clicks; commits carry `Kanbot-Agent` and `Kanbot-Ticket` trailers. Built (M5): the permission hook rewrites an agent's `git commit` to add the trailers and, on a GitHub project, `<app-slug>[bot]` as author. | MVP |
| FR-43 | Captain Ship-It pushes the ticket branch and opens a PR; PR number, URL and head SHA stored on the ticket. Built (M5): the worker pushes (never forced) and opens or updates the PR after Ship-It's run; Ship-It writes the description. | MVP |
| FR-44 | GitHub webhooks (signature-verified) for PRs, reviews, review comments, checks and pushes to main, with 60 s polling as a fallback. | MVP |
| FR-45 | Project setup verifies branch protection on the default branch (PR required, 1 approval, required checks, no force-push) and offers to apply it; agents stay disabled on unprotected projects unless overridden. | MVP |
| FR-46 | CI status shown on cards and in the drawer; failing CI bounces the ticket to In Progress with a log excerpt. | MVP |
| FR-47 | PR Review gate: human review comments are imported, "changes requested" bounces to In Progress, and the Merge button is enabled only after a human approval. | MVP |
| FR-48 | Commits pushed by the human to a ticket branch are detected and never lost or overwritten by Kanbot's own commits; the next run starts from the latest head. A rebase onto main (FR-51) keeps their content and authorship but gives them new SHAs. | MVP |
| FR-49 | Remove the worktree when a ticket reaches Done or is deleted (the worker does it, not Archie); keep the branch until merged. | MVP |
| FR-50 | Touch set per ticket, project hotspot groups, and an overlap check before In Progress (hotspot overlap always serializes); per-project `overlapPolicy` of `serialize` (default) or `parallel`. | MVP |
| FR-51 | When main moves, rebase overlapping in-flight branches; clean rebases push with `--force-with-lease` on `kanbot/*` branches only. | MVP |
| FR-52 | Marge Conflict resolves rebase conflicts; resolved branches go back through Code Review and QA. | Later |
| FR-53 | Stacked branches for dependent tickets, with automatic PR retargeting when the parent merges. | Later |

### Notifications and costs

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-60 | In-app notifications for "needs input", run failure, budget exceeded and PR ready for review; browser notifications when permitted. | MVP |
| FR-61 | Optional outbound webhook (e.g. a Discord channel) for the same events. | Later |
| FR-62 | Cost tracking per run, ticket, agent, project and day (tokens and USD). | MVP |
| FR-63 | Global "Pause all agents" switch: running runs stop at once (`interrupted`, "Stopped by Pause all") and restart on their own when agents resume; nothing new starts. | MVP |

## 7. Architecture and tech stack

Kanbot is a TypeScript monorepo with two processes — a Next.js web app and a Node worker — sharing one PostgreSQL database that also serves as the job queue. No Python anywhere in the stack.

Browser ⇄ web (Next.js) → Postgres ← worker → Claude API, the git repos and GitHub. Postgres `NOTIFY` carries events back from the worker to the web app, and from there over SSE to the browser.

The web app and worker never call each other directly: the web app writes jobs to Postgres, the worker claims them, and live events flow back through `NOTIFY`.

### Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict) end to end | One language for UI, API, worker and agent definitions. |
| Repo layout | pnpm workspaces: `apps/web`, `apps/worker`, `packages/shared`, `agents/` | Shared types and zod schemas between web and worker. |
| Web app | Next.js (App Router), React, Tailwind CSS, shadcn/ui | Board UI plus API route handlers in one app. |
| Drag and drop | dnd-kit | Accessible, keyboard-capable sortable lists. |
| Database | PostgreSQL 16 with Drizzle ORM and drizzle-kit migrations | Typed queries; Postgres also backs the queue. |
| Job queue | The `runs` table itself: the worker claims `queued` rows with `FOR UPDATE SKIP LOCKED`, woken by `NOTIFY` (5 s poll as backup) | Durable, no Redis and no second job record to keep in sync with the run; the concurrency limits are one SQL condition. |
| Agent runtime | Claude Agent SDK (TypeScript), behind an `AgentRuntime` adapter | Same agent loop and tools as Claude Code; adapter keeps other backends possible. |
| Git | `git` CLI via `git()` in `packages/shared/src/server/repo.ts` (`execFile`, no shell) | Worktrees, branches, diffs, commits. |
| GitHub | Octokit | Push status, PR creation, merge detection. |
| Live updates | Server-Sent Events from the web app, fed by Postgres `LISTEN/NOTIFY` from the worker | One-way streaming is all the board needs; simpler than WebSockets. |
| Validation | zod | Agent frontmatter, verdict payloads, API bodies. |
| Testing | Vitest (unit), Playwright (UI end to end) | Fast, TypeScript-native. |
| Deployment | Docker Compose: `web`, `worker`, `db`, plus `caddy` on a server | The owner's PC in WSL now; optionally one Linux server later, with Caddy in front for HTTPS (see Deployment below). |

### Process responsibilities

- **Web (`apps/web`)**: renders the board, serves the REST API, validates transitions, writes ticket moves, enqueues run jobs, streams events to the browser over SSE.
- **Worker (`apps/worker`)**: consumes run jobs, manages worktrees, assembles context, runs agents through the runtime adapter, persists run events, applies verdicts (moves tickets), enforces budgets and concurrency.
- **Database**: source of truth for projects, tickets, runs, events, artifacts and costs; the `runs` table doubles as the job queue; `NOTIFY` channel `kanbot_events` carries live updates and wakes the worker.
- **`agents/` folder**: one markdown file per agent, checked into the Kanbot repo and overridable per project at `<repo>/.kanbot/agents/`.

### Deployment

Kanbot runs with Docker Compose on one Linux machine with rootless Docker. Two setups (decided 2026-11-06, when a paid Droplet turned out more than the owner wanted for now; `docs/deploy.md` has both step by step):

- **Local, in WSL (the current target).** Kanbot gets its own WSL distro with its own rootless Docker, cut off from Windows (no drives mounted, no Windows interop). The web app listens on 127.0.0.1 only, which WSL forwards to the Windows browser. No domain, no Caddy, no webhooks: Kanbot polls GitHub every 60 s instead (section 10, FR-44). Agents work only while the PC is on.
- **A server (optional, later)**, reachable at an HTTPS subdomain so it works while the PC is off and GitHub can send webhooks straight to it. Any Ubuntu VPS: a DigitalOcean Droplet, Oracle Cloud's free tier or another. The bullets below marked "server" apply only here.

- **Server.** Ubuntu LTS, at least 2 vCPUs and 4 GB RAM; 8 GB is safer with two agents running builds and tests at once. On DigitalOcean, a Block Storage volume holds Postgres data and cloned repos so they survive a rebuild.
- **Containers.** `web`, `worker`, `db` (Postgres 16), a one-shot `migrate` that applies migrations before web and worker start, and on a server `caddy` (reverse proxy with automatic HTTPS). In `docker-compose.yml`, profile `app` adds migrate, web and worker, and profile `public` adds caddy; the machine's `.env` sets `COMPOSE_PROFILES` (`app` locally, `app,public` on a server), so local development without it still starts only `db`. The web app is published on 127.0.0.1 only. The images come from the root `Dockerfile` (`--target web` and `--target worker`; the worker adds git and the docker CLI). The worker uses host networking to reach the QA apps that project containers publish on 127.0.0.1. It gets the Docker socket and the repos folder (mounted at the same path), and only the environment variables it needs, never the whole `.env`. DigitalOcean Managed PostgreSQL can replace `db` later. Step-by-step setup is in `docs/deploy.md`.
- **Domain (server).** An A record (e.g. `kanbot.<your-domain>`) points at the server; Caddy obtains the TLS certificate.
- **Network.** On a server, a firewall opens 80 and 443; SSH (22) only from the owner's IP with key auth. Postgres and the web app are never exposed: they bind to 127.0.0.1. Kanbot is never reachable from another machine before Sign in with GitHub exists.
- **Repos.** Projects are cloned from GitHub into `/srv/kanbot/repos/<project>` with the GitHub App token; worktrees live beside them.
- **Secrets.** The Anthropic API key, the session secret and the encryption key for the stored GitHub App credentials live in an owner-only (`chmod 600`) `.env`; each container gets only the variables its service lists. Agent shell commands run with a scrubbed environment that excludes them.
- **Project toolchains (built in M5).** The `worker` image carries Node and Kanbot only. Every project command (install, build, lint, test, start, and agents' `{test}`-style shell tools) runs in the project's own image instead, found without the owner doing anything when the repo says which:
  - the repo's `.devcontainer/devcontainer.json`, if it has one: the image its `image` field names, or the image Kanbot **builds** from the Dockerfile its `build.dockerfile` (or older `dockerFile`) points at;
  - else `image:` in `.kanbot/project.yml`;
  - else `KANBOT_DEFAULT_IMAGE`, which `docker-compose.yml` sets for the containerized worker (default `node:24-bookworm`). Without it, project code would run inside the worker's own container, beside the Docker socket, which would hand it every other container;
  - else (development, where the variable is unset) none: the host's own toolchain, as the sample repo and tests run. Guessing an image from the project's language belongs to onboarding's command detection (section 10).

  Like the other project settings these are seeded once from the default branch. Settings' **Image** overrides them. A plain root `Dockerfile` is ignored, because it is usually a production image without test tools (decided 2026-11-06). Devcontainer `features`, `postCreateCommand` and docker-compose devcontainers are not applied.
  - The build (`projectImage()` in `apps/worker/src/docker.ts`) always uses the default branch: `git archive <default>:<context>` piped into `docker build`, never a worktree or the checkout's working copy, so an agent can't change what it runs in. The tag is `kanbot-<key>:<the context's tree hash>`, so the image is rebuilt only when the build context changes on the default branch. A build that fails fails the run with the build's output. The Dockerfile must be inside its build context. Kanbot never installs a language toolchain itself, so a Python, Go or Rust project works the same as a Node one.
  - Each command is one `docker run --rm --init` (`apps/worker/src/commands.ts`, `docker.ts`): the worktree bind-mounted at the same path and used as the working directory, a shared `kanbot-cache` volume as `HOME` for package caches, no host environment (only the project's own env vars, section 10, through `--env-file` so no value is on a command line), and the label `kanbot` so leftovers can be found. A command killed by its 10-minute timeout has its container removed by name. The image must be a plain image reference (it may not start with `-`); Settings and the devcontainer reader refuse anything else.
  - Agents' Bash calls go through the permission hook as written; when one is a project command (with any arguments), the hook rewrites it into that `docker run`, labelled with the run's id, and the worker removes any such container still running when the run ends. git and other commands stay on the host. Git is not available inside the container (only the worktree is mounted, not the repository's `.git`).
  - Docker runs **rootless** on the server (decided 2026-11-06), and the worker uses the plain `docker` CLI against that daemon's socket: the daemon itself has no root, so no socket proxy is needed. Containers are not network-limited (Later, with per-run containers).
  - The QA app (section 4) runs the same way, publishing its port on 127.0.0.1 only. The image is pulled before the app's 60 seconds start.
- **Isolation.** Nothing runs as the host's root. Docker is rootless and runs as the `kanbot` user. The worker runs as root inside its container, which under rootless Docker *is* that unprivileged user on the host, so the socket, the repos and the files project containers write share one owner. Because the server is public and agents run `npm install` and test scripts, per-run containers (section 14) are recommended before pointing agents at repos with untrusted dependencies. Running project commands in the project's image (above) is the first half of that; network limits are the second (Later).
- **Backups.** Nightly `pg_dump` from a cron job on the host (`docs/deploy.md`): copied to DigitalOcean Spaces (or similar) on a server, kept in the distro and copied out by hand in WSL.
- **Nightly cleanup.** The worker prunes run logs past 90 days (each ticket's last run kept), worktrees that Done tickets still hold, and Kanbot-built project images nothing has used for a week. It runs a minute after start, then every 24 hours (`apps/worker/src/cleanup.ts`). The shared package cache volume is cleared by hand if it grows.
- **Deploys.** `.github/workflows/deploy.yml` runs after CI passes on main. It connects to the server over SSH, checks out that commit and runs `docker compose up -d --build` (the server's `.env` picks the profiles), so images are built on the server and no registry is needed. In WSL, updates are `git pull` and the same command by hand. It stays off until the repo variable `KANBOT_DEPLOY` is `on`. CI also builds the images, so a broken Dockerfile fails there first. The worker exits if it loses its single-worker lock, and compose restarts it.

## 8. Agent orchestration and runtime

Every ticket move that lands in an agent column becomes a queued `runs` row; the worker runs the agent in the ticket's worktree, streams its events, and acts on the verdict the agent reports through a required tool call.

### Agent definition file

Each agent is `agents/<slug>.md`: YAML frontmatter for config, markdown body for the system prompt. Frontmatter is validated with zod each time a run starts; a run whose agent file is invalid fails with the validation error (the Agents page shows it, and the drawer's latest-run bar links a run to the version of the file it read: `runs.config_hash`, with the text kept in `agent_versions`, FR-37). A missing file means the column is a gate.

In `tools`, `{install}`, `{build}`, `{test}` and `{lint}` expand to the project's commands from Settings (an entry whose command the project lacks is dropped). `Bash(cmd:*)` and `Bash(cmd *)` allow `cmd` with any arguments; `Bash(cmd)` allows exactly `cmd`. Project commands must each be one plain command (no `&&`), because the permission hook refuses chained commands.

```markdown
---
slug: nitpick-nancy
name: Nitpick Nancy
tagline: Has opinions about your semicolons.
avatar: avatars/nitpick-nancy.svg
color: "#be185d"  # optional; marks the column, its cards and the avatar (default slate)
column: code_review
model: claude-sonnet-5-5
tools: [Read, Grep, Glob, "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash({lint}:*)", Skill]
editScope: none   # none | worktree | test_globs: where Edit/Write may write
plugins:
  - name: ponytail
    level: "off"
maxTurns: 40
timeoutMinutes: 20
maxBudgetUsd: 0.75
verdicts: [success, changes_requested, failed, needs_input]
statusLines:
  running: "Nancy is squinting at line {line}..."
  changes_requested: "Nancy found {count} things to nitpick."
  success: "Nancy grudgingly approves."
---
You are a senior code reviewer. Review the diff on this ticket's branch against
the plan and acceptance criteria provided in context...
```

### Plugins and skills

Agents can load Claude Code plugins and skills, declared in frontmatter and bundled into the worker image, so nothing is installed by hand.

```yaml
plugins:
  - name: ponytail
    level: full   # lite | full | ultra | off
```

- **Bundled and pinned.** Plugins are vendored into the Kanbot repo at `plugins/<name>/` at a fixed version and copied into the worker image at build time. Updating one is a deliberate PR to Kanbot, reviewed before merging.
- **Loaded per run.** The runtime adapter passes each agent's plugin folders to the Agent SDK's `plugins` option (`{type: "local", path}`). Ponytail's level reaches its hooks as `PONYTAIL_DEFAULT_MODE`.
- **Sandboxed.** Plugin hooks run inside the agent's environment with the same scrubbed variables as agent commands.
- **Project skills.** Skills in a target repo's own `.claude/skills/` folder load too, if the project enables them in settings.

### Ponytail

Ponytail (open source, MIT, `DietrichGebert/ponytail` on GitHub) makes agents reuse existing code, the standard library and platform features before writing new code. Each deliberate shortcut is marked with a `shortcut: <limit>, <when to upgrade>` comment.

| Agent | Ponytail | Why |
| --- | --- | --- |
| Sir Codes-a-Lot | full | Writes the code, which is where bloat comes from. |
| Marge Conflict | full | Resolutions should be the smallest correct change. |
| Plan B | lite | Simpler plans lead to simpler code, without trimming the spec. |
| Nitpick Nancy | off, review skill | Ponytail is loaded with its mode off, so its rules don't bias the review; Nancy may run the `ponytail:ponytail-review` skill on the diff to flag over-engineering, and treats `ponytail:` and `shortcut:` comments as intentional rather than defects. |
| Testy McTestface | not loaded | Tests should be thorough, not minimal. |
| Dr. Rabbit Hole, Captain Ship-It, Rubber Duckworth, Archie | off | Not writing application code. |

Before raising any level, compare the same tickets with Ponytail on and off with the golden-ticket eval (below): bounce count, cost and diff size.

### Other bundled plugins

More plugins ship in the worker image, each enabled only for the agents that benefit; every plugin adds context to every turn, so the set stays small. Each is added once the golden-ticket eval can compare it on and off. So far Ponytail and Security audit ship; the rest are in §16. Playwright was replaced by Kanbot's own browser tools (below).

| Plugin | Source | Agents | Notes |
| --- | --- | --- | --- |
| Security audit | `cloudflare/security-audit-skill` (MIT), vendored at `plugins/security-audit/` | Nitpick Nancy | Built (M4.5). Nancy runs its `security-review` skill on every code diff: trace untrusted input in the changed code to dangerous sinks, then check access control, secrets, file handling, business logic and the obvious exposures. Only the skill's guidance mode is used: no files written, no target code run. Its full audit (parallel sub-agents, report files, an OS sandbox) doesn't fit a read-only reviewer. Agents can't read outside their working directory, so the skill is one file: a Kanbot header plus the upstream core principles, attack classes, and web and client-side companions, verbatim (`VENDORED.md`). A vulnerability the branch introduces, with a source trace, is a blocking comment back to Sir Codes-a-Lot. |
| TypeScript LSP | Official Anthropic marketplace | Sir Codes-a-Lot, Marge Conflict, Nitpick Nancy, Plan B | Real code intelligence (definitions, all references) instead of text search; makes Nancy's cross-ticket checks exact. The worker image includes the language server. For non-TypeScript projects, onboarding enables the matching official LSP plugin instead. |
| Context7 | Partner (MCP) | Plan B, Sir Codes-a-Lot, Dr. Rabbit Hole | Current library documentation, so agents don't code against outdated APIs. Calls an external service, so the worker's network allowlist includes it. |
| Security Guidance | Official Anthropic marketplace | Sir Codes-a-Lot, Nitpick Nancy | The agent reviews its own changes for common vulnerabilities and fixes them in the same run. Uses the project's `.claude/claude-security-guidance.md`, which onboarding drafts. |
| ~~Playwright~~ | Official Anthropic marketplace | Testy McTestface | **Not used** (M5, 2026-11-07): Testy's browser is Kanbot's own five tools on its in-process MCP server (section 4). The plugin runs its own MCP server with about 25 tools, `browser_evaluate` (arbitrary JavaScript) among them, so fencing it to the app would mean a URL check per tool in the permission hook plus trusting its origin flag for everything a click can trigger; Kanbot's tools fence every request in one place, and add five tool schemas to Testy's turns instead of 25. |

**Candidates for later:** code-review (an optional deep review Nancy triggers only for large or risky diffs, since it runs several parallel agents), chrome-devtools-mcp (console and network debugging for Testy), and Sentry (turning production errors into tickets).

**Deliberately not used:** workflow plugins such as Superpowers and feature-dev, because the board is the workflow; GitHub and commit plugins, because agents never touch GitHub directly; and memory plugins, because Archie's CLAUDE.md suggestions cover what carries between tickets.

### Run lifecycle

1. **Enqueue.** The web app writes the move and creates a `run` row in state `queued` in the same transaction; its `NOTIFY` wakes the worker. Only one active run per ticket (partial unique index); a new move cancels the old one first.
2. **Prepare.** The worker claims the oldest queued run that fits the concurrency limits (global default 2, per-project default 1) in one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` under an advisory lock and sets state `running`. For In Progress, Code Review and QA runs it creates or reuses the ticket's worktree (section 14), running the project's install command when it creates one, and again on a later run when the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`) differs from the one at the last install (a marker in the worktree's git dir; a failed reinstall keeps the worktree). If install fails, the worker removes the new worktree again (the branch stays) and the run fails, so the next run installs from scratch.
3. **Assemble context.** The worker builds the prompt from: ticket fields, acceptance criteria, latest plan artifact, summaries of the last 3 runs, unresolved review comments or bug reports, user comments since the last run, the project CLAUDE.md, and the git diff stat. Large items are truncated with a pointer to the file in the worktree.
4. **Execute.** The runtime adapter starts the agent with `cwd` = worktree (before a worktree exists, as for Plan B: the project checkout, read-only), only the agent's built-in tools, its system prompt, and a custom `report_result` tool that is always loaded. A `PreToolUse` hook refuses any call outside the frontmatter `tools`, any file path or glob that resolves outside `cwd` (symlinks followed), any Edit/Write outside the agent's edit scope, and any shell command that isn't one plain invocation matching the agent's `Bash(...)` allowlist (the SDK auto-runs read-only commands such as `cat` and `ls` in every permission mode, so the hook is the fence). The SDK runs in `dontAsk` mode with `blockReadsOutsideWorkingDirectories` as a second layer, and the agent gets no user or project Claude settings (`settingSources: []`) and no `DATABASE_URL`. Every SDK message is saved as a `run_event` (API key redacted) and announced on `NOTIFY` by id only, because `NOTIFY` payloads are capped at 8 KB.
5. **Report.** The agent calls `report_result` with the verdict payload below. The worker validates it with zod, stores artifacts and comments, records final tokens and cost, and sets the run state.
   - **Checks gate.** After an In Progress run reports `success` and passes the post-run checks, the worker runs the project's build, lint and test commands in the worktree. It runs them in that order, skips any the project lacks or that already failed on the default branch at onboarding (the baseline, §10 step 5), stops at the first failure, and gives each a 10-minute timeout. A failure ends the run `changes_requested` with the error "Kanbot checks: `<command>` failed". The worker stores the last 200 lines of output as a `test_report` artifact, which reaches Sir Codes-a-Lot's next run as `<latest_test_report>`. The gate needs no agent and costs nothing, and a branch that doesn't build or pass its own tests never reaches Code Review. Sir Codes-a-Lot is told to run the same commands, so the gate only catches what he skipped or got wrong.
6. **Transition.** The worker applies the transition table (section 3) inside a database transaction, records it in the activity log, and enqueues the next column's agent if the move is automatic.

Run states: `queued`, `running`, `awaiting_input`, `succeeded`, `changes_requested`, `failed`, `cancelled`, `timed_out`, `budget_exceeded`, `interrupted`.

### Verdict payload

```json
{
  "verdict": "changes_requested",
  "summary": "Two blocking issues: missing input validation on POST /tickets, no test for WIP limit.",
  "artifacts": [
    { "kind": "review", "title": "Review #2", "markdown": "..." }
  ],
  "comments": [
    { "file": "apps/web/app/api/tickets/route.ts", "line": 42, "body": "Validate body with zod." }
  ],
  "questions": [],
  "acceptanceCriteria": ["POST /tickets returns 400 for an empty title"],
  "criteriaResults": [
    { "criterionId": "ac_3", "status": "fail", "note": "WIP limit not enforced on drag" }
  ],
  "proposedTickets": [],
  "crossTicketRisks": [
    { "ticket": "KB-12", "kind": "api_response", "severity": "warning", "description": "GET /tickets now returns `labels` as objects; KB-12's board filter expects strings." }
  ]
}
```

`acceptanceCriteria` is Plan B's checklist. On `success` it replaces the previous agent-written criteria; the owner's own criteria are never touched. The `report_result` schema is `packages/shared/src/verdict.ts`. Plan B also sends `touchPaths` (its predicted touch set) and `relatedTickets` (section 9). Nancy sends `comments` and `crossTicketRisks`, and Testy sends `criteriaResults`, keyed by the criterion ids shown in the context. On an epic, Plan B also sends `proposedTickets` (UC-11). The worker drops duplicate refs and keeps `blockedBy` only for earlier refs, so the dependencies can't form a cycle, and stores the list on the plan artifact's `data`. Each review replaces the reviewer's earlier comments (they are marked resolved), so unresolved comments are always the latest review's.

### Rules the orchestrator enforces

- **Cancellation**: moving a ticket away, "Pause all", or a budget breach aborts the run via an `AbortController`; commits already made stay on the branch. The ticket's next run waits until the aborted one has fully stopped, so two agents never share a worktree.
- **Crash recovery**: one worker per database (a Postgres advisory lock; a second worker exits at start). On worker start, any run left in `running` becomes `interrupted` and the ticket shows a Retry / Resume choice. A run whose result the worker cannot record (a git or database error after the agent stopped) is marked `failed` with that error at once, so it never holds a concurrency slot.
- **Resume**: a run that ends `awaiting_input` (`needs_input`) is finished, like `failed`: it keeps the agent session ID (taken from the session's first message, so a run stopped by stall detection has one too) and frees the ticket's one active run, so Rubber Duckworth can run on the Blocked ticket. When the owner clicks Resume (with an answer, or none, e.g. after raising the cap), any Duckworth run still going is cancelled and a new run of the same agent starts in the column the blocked run was in, with `resume_session_id` set: the SDK resumes that session and the answer is in the context as `<owner_answer>`. If the session file is gone (sessions are files under the run's working directory on the worker's machine), the run starts cold with the same context. Resume works after `awaiting_input`, `failed`, `timed_out`, `budget_exceeded`, `changes_requested` (bounce limit) and `interrupted`, and only for the ticket's latest run outside Blocked. If the ticket is at its bounce limit, Resume resets its bounce count to 0 (logged as an `edited` activity), so the resumed reviewer's next change request bounces it again instead of blocking it at once. A bounce back to In Progress (Code Review or QA) also resumes Sir Codes-a-Lot's last session there (FR-35); reviewers start fresh each time.
- **Post-run checks**: after every run in a worktree, the worker fails the run (ticket to Blocked, commits kept, nothing reverted) if the worktree left its ticket branch, any commit the run made reached the default branch (the owner committing to the default branch during a run is fine), commits that existed before the run were rewritten (amend, reset, rebase), the run changed any file under `.kanbot/`, or the run changed files outside the agent's `editScope` (for Testy McTestface: the project's test globs). Only what the run itself committed or left dirty counts; files an earlier run left behind are not its change.
- **Idempotency**: jobs carry the run ID; a run that is already terminal is never executed twice.

### Stall detection

Hard limits (turns, timeout, budget, bounce limit) guarantee every run ends; stall detection ends a spinning run early. The worker enforces these rules itself rather than trusting the agent to notice.

| Signal | Rule | Result |
| --- | --- | --- |
| Repetition | The same tool call with the same arguments 3 times with no file edit in between (a command failing with the same error 3 times is the same call; rerunning tests after an edit is not; a QA request that changes the app, anything but GET, HEAD or OPTIONS, counts like an edit, and so does a click or typing in QA's browser) | Run stops with `needs_input` and the repeated action as the reason |
| No progress | 25 tool calls (about 15 turns) with no file edit, no run of the project's test command and no request to the QA app; only for agents that may edit (the read-only agents read many files by design; golden runs peak at 5) | Run stops with `needs_input` |
| Repeated feedback | Code Review or QA raises essentially the same issue (same file, line and message) on a second bounce | Ticket goes to Blocked instead of bouncing again (M6) |
| Recurring block | A ticket lands in Blocked a second time for the same reason | Duckworth sees his earlier blocker summaries in his context, flags the block as recurring and asks first whether to re-plan or split the ticket |

**Rubber Duckworth's own limits.** Duckworth only diagnoses: read-only access, no shell, around 10 turns and a $0.25 budget, one run per entry to Blocked. It can't resume or move a ticket; only the owner's answer and Resume do that. If its run fails, the worker posts a plain fallback summary (last error and last verdict) as his comment and the ticket stays in Blocked. However his run ends, the ticket is flagged `needs_input`. He reads the blocking run's questions from its `report_result` call in the run log.

### Failure handling

Outside services fail routinely, so the worker sorts every error into transient (retried quietly) or permanent (surfaced immediately), and the board always shows what is degraded.

| Failure | Behavior |
| --- | --- |
| Anthropic rate limit (429) or overloaded / 5xx | The Agent SDK's built-in retry with backoff handles it; each retry is logged as a "waiting on API" line in the Live tab and turns the health indicator amber. Retries don't count against the run's turn limit. If the SDK gives up, the run becomes `interrupted`, the ticket stays put with Retry. |
| Anthropic unavailable for more than 10 minutes | Run becomes `interrupted` and a banner appears; runs resume automatically once a health probe (every minute, listing models: free) succeeds. Only a ticket's latest run restarts, and only while the ticket is still in that run's column with nothing active, so anything the owner did meanwhile wins. Runs stopped by Pause all restart the same way when agents resume. |
| Anthropic auth or billing error (invalid key, no credit) | The run fails and all agents pause, with the error as the pause reason in the banner and a notification; nothing retries until the owner resumes. |
| GitHub rate limit | Wait until the reset time GitHub reports; GitHub calls queue instead of failing runs. |
| GitHub push or PR creation fails | Retry 3 times, then move the ticket to Blocked with the error. PR creation checks for an existing PR first, so retries never open duplicates. |
| A command hangs (tests, install) | A per-command timeout (default 10 min) kills the process; the agent sees the timeout and decides what to do. (The worker's own install has it, and an agent's Bash tool gets `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` set to 10 minutes.) |
| Worker crashes mid-run | On restart the run becomes `interrupted`; pushes are safe to repeat because they target a known commit. |
| Database unavailable | The web app shows an error page; the worker stops claiming jobs until it reconnects. |
| Disk over 90% full | No new runs start and a banner appears. A nightly cleanup job prunes worktrees of finished tickets, package caches and run logs past retention, so this should be rare. Built (M6): the worker claims nothing while a project's repo filesystem is over 90% (runs already going finish), `/api/health` reports `disk`, and the board banner says so. Only project repo filesystems are checked, not Postgres's or Docker's storage. |

`GET /api/health` reports database, worker, Anthropic and GitHub status; the board's top bar shows it as a single indicator. The worker counts as up while it holds a Postgres connection named `kanbot-worker` (`pg_stat_activity`), so no heartbeat table is needed. Anthropic is judged from the latest runs: an API retry in a running run is `degraded`, an API error on the last finished run is `down`. GitHub is judged by a call to `GET /app` with the App's own key: `ok` when it answers, `degraded` when GitHub refuses the key (4xx, e.g. the App was deleted), `down` on a network error or a 5xx, `unknown` before an App is connected. It is checked on each health poll (every 30 s from the board), with no cache.

### Testing without real agents

The orchestrator is tested against a replay runtime, so automated tests are fast, repeatable and never spend tokens.

- `ReplayRuntime` implements the same `AgentRuntime` interface as the SDK adapter and is selected with `KANBOT_RUNTIME=replay`. It plays `fixtures/runs/<agent>/<scenario>.json`, where the scenario is a ticket label `replay:<name>` (else `default`), so an e2e test picks a script by labelling a ticket.
- **Scripted runs.** A test declares each agent's events and final verdict (e.g. Nancy returns `changes_requested` twice, then `success`) to exercise bounce limits, Blocked, budgets and cancellation. A scripted run can include a patch that the replay applies to the worktree, so the diff, CI and PR paths have real changes to work with.
- **Recorded runs.** With `KANBOT_RECORD=1`, a real run on a ticket labelled `replay:<scenario>` is saved as `fixtures/runs/<agent>/<scenario>.<n>.json` (the agent's nth run on that ticket) in the same format as hand-written scripts: events, report, usage and the run's commits as one patch, secrets redacted, the run's folder replaced by `<cwd>` and criterion ids by `$criterion1`… placeholders. Replay plays `<scenario>.<n>.json`, else `<scenario>.json`, else the agent's `default.json`, and applies a script's patch as a real commit.
- **Simulated failures.** Replays can inject API 429s, timeouts, crashes mid-run and malformed verdicts to test the failure handling above.
- Vitest and Playwright suites use only the replay runtime; CI never calls the real Anthropic API. Real agents are checked with the golden-ticket eval below.

### Checking agent quality

Prompts, models and plugins decide how good the agents are, so any change to them is checked against a fixed set of tickets before it merges.

- **Golden tickets.** Five tickets in `fixtures/golden/` on the sample repo (`fixtures/sample-repo`, a zero-dependency Node + TypeScript todo app): a small feature, a bug fix (the bug is planted), a UI change, one written so Code Review should request changes, and one whose hint invites stored XSS, for the security pass (`security`). A ticket the baseline doesn't have yet is reported but not compared.
- **When it runs.** Before merging any change to an agent's prompt, model, plugins or limits, the golden tickets run end to end with real agents (`pnpm eval:agents`). The owner runs it locally and records the result in the PR description before merging a PR that changes an agent or plugin.
- **What it compares.** For each ticket: whether it reached the end of the build loop (QA passed, awaiting approval; PR Review once Ship exists in M5), bounce count, cost, run time and diff size, against the owner's local `evals/baseline.json`. `--baseline` saves the run as the new baseline only if every ticket reached the end of the build loop. Results go to `evals/results/`; the whole `evals/` folder is gitignored (run data and the baseline stay out of the repo), and are summarized in the PR description. The eval runs in the `kanbot_test` database with an in-process worker loop, and approves each plan as soon as it's ready.
- **Pass bar.** If any golden ticket fails to finish, or total bounces or cost rise by more than 25%, the change needs the owner's explicit OK before merging.
- **Cost.** A few dollars per check, under the same budget caps as normal runs.

## 9. Overlapping tickets and merge conflicts

Kanbot avoids most collisions before code is written by tracking which files each ticket expects to touch, and handles the rest at merge time with a rebase, resolve and re-test loop.

### How overlap is detected

1. **Touch set.** Plan B's plan must list the files and folders it expects to change (paths or globs). These are stored on the ticket as `touch_paths`. After each Sir Codes-a-Lot run, the worker adds the files the branch actually changed.
2. **Related tickets.** Plan B receives the titles, plan summaries and touch sets of all open tickets, and its verdict must name related or dependent ones (`relatedTickets`, each `blocks`, `blocked_by` or `relates`). Each one is stored as an unconfirmed proposal (`confirmed = false`, `source = agent`); the drawer shows it with Confirm and Dismiss, and only confirmed links count. Keys from other projects or unknown tickets are ignored.
3. **Hotspots.** Each project names groups of files where concurrent changes almost always collide, such as the database schema or route definitions. Two tickets touching the same hotspot group overlap even if no individual file matches.
4. **Overlap check.** Before a ticket enters In Progress, the move compares its touch set and hotspot groups with every ticket between In Progress and PR Review. On overlap the move is refused (409 `overlap`, e.g. "Overlaps tickets in flight: KB-12 (3 files, hotspot database)") and the board asks whether to start anyway. A ticket with no touch set yet overlaps nothing. The same check also refuses a ticket with a confirmed `blocks` link from a ticket that is not yet in Done ("Waiting on KB-3"), even with no touch set. Cards in Ready and the in-flight columns show "waiting on KB-n" and "overlaps KB-n".
5. **Cross-ticket review.** Nitpick Nancy checks each diff against the other in-flight tickets for contract changes that no file comparison can see, such as an API response shape another ticket depends on.

### What happens when tickets overlap

| Situation | Default policy | Alternative |
| --- | --- | --- |
| B depends on A (`blocks` link) | B waits in Ready until A merges; card shows "waiting on KB-12". | **Stack**: B branches from A's branch, its PR targets A's branch, and it retargets main when A merges. |
| Touch sets overlap, no dependency | **Serialize**: B waits until A merges. Set per project with `overlapPolicy: serialize`. | `overlapPolicy: parallel`: both run; conflicts are resolved when one rebases onto the other. |
| No overlap | Run in parallel up to the concurrency limit. | — |
| Children of one epic | Run in the order Plan B proposed, respecting their `blocks` links. | User reorders. |

Overlap checks are advisory, not file locks: the user can override a wait with "Start anyway". When tickets do run in parallel, Sir Codes-a-Lot's context includes the plan summaries of the other in-flight tickets touching the same files, so it avoids contradictory design choices.

### Hotspots

Hotspots are declared per project in Settings, as named groups of globs (the first read of a project seeds them from `.kanbot/project.yml` in the repo):

```yaml
hotspots:
  - name: database
    paths: ["db/schema.ts", "db/migrations/**"]
  - name: api-routes
    paths: ["apps/web/app/api/**/route.ts"]
  - name: env
    paths: [".env.example", "packages/shared/src/env.ts"]
```

`commands` (install, build, test, lint, start), `image` (section 7) and `testGlobs` live in Settings too. The database is the source of truth. The first time Kanbot reads a project with a linked repo and no settings, it seeds them once from `.kanbot/project.yml` on the default branch (`git show <default>:.kanbot/project.yml`, never a worktree); later edits to the file change nothing. Agents may not change the file at all (post-run check), and they have no way to reach Settings, so they can't widen their own allowlist. Settings refuses a command that isn't one plain command, because the permission hook would refuse it anyway.

- Globs are matched against both predicted and actual touch sets.
- Hotspot overlap always serializes, even when `overlapPolicy` is `parallel`, unless the user clicks "Start anyway".
- On a project's first plan, Plan B suggests hotspots from the files changed most often in recent git history and from shared config, schema and route files. The user confirms or edits them.
- Tickets touching different hotspot groups do not overlap through hotspots.

### Cross-ticket review by Nitpick Nancy

Nancy catches the overlap that file lists miss: one ticket changing a contract that another in-flight ticket relies on.

- **Extra context.** For every other ticket between In Progress and PR Review: its title, plan summary and branch diff, capped at 1,500 lines in total. Past the cap she gets diff stats and plan summaries only.
- **What she checks.** Changes to exported function signatures and types, API request and response shapes, database columns, environment variables and event names that another in-flight ticket uses or also changes.
- **What she reports.** Her verdict adds `crossTicketRisks`, each with the other ticket, the kind of contract, a description and a severity.
- **Blocking risk.** Merging both would break, and the fix belongs on this ticket's branch. When the fix belongs on the other branch, or on whichever merges second, it is a warning: the bounce would go to a builder who can't change the other branch. Treated as `changes_requested` (the worker downgrades a `success` that carries one). The note is posted on both tickets, and the other ticket is proposed as a blocker (an unconfirmed `blocks` link) for the human to confirm.
- **Warning.** A comment on both tickets; no bounce.

### Keeping in-flight branches current

- Before every agent run in a worktree column, the worker fast-forwards the clone's default branch from GitHub and, if the ticket branch is behind it, rebases the branch first. Agents never run git rebase themselves. Authors are kept; the committer is Kanbot.
- A branch with a PR is first brought up to what is on GitHub (FR-48): a fast-forward when Kanbot has nothing new, and when both sides have commits, Kanbot's commits are replayed on top of the owner's, which that step leaves as they are. The rebase onto main that follows rewrites the whole branch, the owner's commits included: same content and authors, new SHAs, so the owner resets their local copy after Kanbot's force-push.
- When a PR merges into main, the watcher rebases every other ticket in PR Review (or in Ship waiting on CI) with no run in flight whose touch set or hotspot overlaps the merged ticket's. Tickets still before Ship rebase when their next run starts.
- A rebased branch with a PR is pushed with `--force-with-lease`, leased on the head GitHub had when it was fetched. This is the only force-push in the system, done by the worker and only on `kanbot/*` branches. CI then reruns on GitHub.
- A worktree with uncommitted changes to tracked files is not rebased (a stash re-apply can fail silently); the branch stays behind main until a run starts on a clean worktree. Untracked files, such as build output, don't count.
- The watcher rebases once per merge and doesn't retry a failure (it is logged); the next run's own rebase covers that ticket. A run that starts between the watcher's idle check and its rebase can race it.
- A rebase with conflicts is aborted (the branch is left as it was) and the ticket goes to Blocked with the conflicted files and hunks as a test-report artifact (shown as a diff, not side by side, until the side-by-side diff exists). Until Marge Conflict ships (M6), that is every conflict.

### Marge Conflict

**Marge Conflict** — "Nobody leaves until we all get along." Marge is the one agent triggered by an event rather than a column: a rebase that hits conflicts. The ticket stays in its column with a "Marge is mediating" pill.

- Context: the conflicting hunks, both tickets' plans and acceptance criteria, and the merged PR's description.
- Tools: edit only the conflicted files in the worktree, run build and tests, commit. No push.
- On `success`, the resolved branch goes back through Code Review and QA, because resolved code is new code.
- On `needs_input` (she can't tell which intent should win), the ticket goes to Blocked with the conflict hunks shown side by side for the human. Until Marge ships (M6), every conflicting rebase goes straight to Blocked this way.

## 10. GitHub, CI and human review

GitHub is required: it holds every branch and PR, runs CI, and its branch protection guarantees nothing reaches main without the human's approval, even if an agent misbehaves.

### Connecting to GitHub

- **Identity.** A GitHub App, created and installed through the two-click setup below. Not the user's own token: GitHub does not let a PR's author approve it, so the user could not be the required reviewer on PRs opened in their own name.
- **Permissions.** Contents read/write (clone, push branches); pull requests read/write; workflows read/write (GitHub requires it to add or change files in `.github/workflows`); administration read/write (apply branch protection); checks and commit statuses read; metadata read. Only the worker holds the token; agents never see it.
- **Commits.** Authored by the bot identity, with trailers naming the agent and ticket (`Kanbot-Agent: sir-codes-a-lot`, `Kanbot-Ticket: KB-42`) so `git log` shows who did what.
- **Events.** Webhooks for `pull_request`, `pull_request_review`, `pull_request_review_comment`, `check_suite` and `push`, sent to `/api/webhooks/github` and verified by signature. A server with a public HTTPS URL gets webhooks directly, with polling every 60 s as a fallback for missed deliveries. Run locally in WSL (section 7), GitHub can't reach Kanbot, so the 60 s polling is the only path; a tunnel (e.g. Cloudflare Tunnel) can bring webhooks back later.

### Two-click setup

Kanbot creates its GitHub App from a manifest, so the owner never copies keys or configures webhooks.

1. During onboarding the owner clicks **Connect GitHub**. The browser opens github.com showing an app pre-filled by Kanbot: name, the permissions above, a webhook URL pointing at the server, and a callback URL for sign-in. The owner clicks **Create**.
2. GitHub asks where to install it. The owner picks repos (or all repositories) and clicks **Install**.

GitHub redirects back to Kanbot, which exchanges the one-time code for the app's ID, private key, OAuth client and webhook secret and stores them encrypted (AES-256-GCM) in `settings.github_app`, with the encryption key (`KANBOT_ENCRYPTION_KEY`) in the `.env`. Kanbot then sends the owner on to the App's install page, the second click. The same app provides Sign in with GitHub for Kanbot's own login, restricted to the owner: the account that created the App (the manifest exchange names it), so there is nothing to configure. Adding repos later is the **Add repos on GitHub** link on Home.

Built details (M5):

- **One App per Kanbot.** Setup runs only while no App is stored, so nobody can swap in their own App later. To start over, delete the App on GitHub and clear `settings.github_app`.
- **Localhost only.** Before an App exists, anyone who can reach the setup page could connect their own App and become the owner. Setup is guarded by the localhost-only rule (below), so on a server the first setup goes over an SSH tunnel (M6).
- **The App's name** is `kanbot-<6 hex>`, because App names are unique across GitHub.
- **URLs** come from the origin the browser used, so the same address must be used for sign-in later: an App created on `http://localhost:3000` signs in there, not on `127.0.0.1`.
- **No webhook while Kanbot polls (WSL).** GitHub refuses a manifest whose hook URL is localhost, even an inactive one (found on the first real try, 2026-11-07), so the manifest leaves out `hook_attributes` and `default_events`. A public server adds them in the App settings (or with `PATCH /app/hook/config`) (M6).

### Branch protection on main

During project setup Kanbot checks, and offers to apply, these rules on the default branch:

- Require a pull request before merging.
- Require 1 approving review. The bot opened the PR, so it cannot approve it; the approval has to be the human's.
- Require the CI status checks to pass and the branch to be up to date.
- Block force-pushes and deletion.

Kanbot will not start agents on a project whose default branch is unprotected unless the user ticks an explicit override.

### CI pipeline

- Each target repo has a GitHub Actions workflow (e.g. `.github/workflows/ci.yml`) running install, lint, build and test on every push to a `kanbot/*` branch and on every PR. Project setup offers a starter workflow built from the project's commands.
- Agent-run tests are fast feedback during In Progress and QA; CI is the source of truth for merging.
- CI is the check runs GitHub reports on the PR's head: any failed (failure, cancelled, timed out, action required) fails it; all completed passes it. A repo with no workflow files on the ticket's branch has no CI to wait for (owner's decision, 2026-11-07): its shipped ticket goes straight to PR Review, shown as no CI. A repo with workflows that never report on the branch keeps the ticket waiting in Ship; drag it on yourself.
- CI failing on a PR bounces the ticket to In Progress with the failing job's log excerpt attached.

### The human review loop

Captain Ship-It opens the PR with a description linking the ticket, plan, review and test report. The ticket waits in Ship until CI is green, then moves to **PR Review**, a human gate. There the human can:

| Action | Where | Result |
| --- | --- | --- |
| Approve and merge | GitHub (a Merge button in Kanbot is on the M6 table) | Ticket to Done; Archie runs. Kanbot never merges without a human click. |
| Request changes | GitHub review, or comments in Kanbot's Diff tab | Comments imported; ticket bounces to In Progress; Sir Codes-a-Lot pushes fixes to the same PR, which goes back through Code Review and QA. A "small fix" checkbox to skip straight back to PR Review is on the M6 table. |
| Push their own commits | Locally or on GitHub | Kanbot records the new head; the next agent run starts from it, and Kanbot's own commits never overwrite them (a rebase onto main later gives them new SHAs, §9). |
| Close the PR | GitHub | Ticket returns to Backlog; worktree removed, branch kept. |

### Where the human is in the loop

1. Approving the plan (Planning → Ready).
2. Approving the move to Ship after QA (default on, can be turned off).
3. Answering Blocked questions, including conflicts Marge can't settle.
4. Reviewing and merging every PR (always required, enforced by GitHub).
5. Any time: commenting, editing a ticket, dragging it elsewhere, pushing commits, or pausing all agents.

### Onboarding a repo

Adding a project is one guided flow; every step that changes the repo does so through a pull request the owner merges.

1. **Connect GitHub (first time only).** Click Connect GitHub, then Create and Install on the pre-filled github.com pages (two-click setup above).
2. **Pick a repo** from those the App can see, and choose a key prefix (e.g. `KB`).
3. **Clone.** Kanbot clones it to `/srv/kanbot/repos/<project>` on the server.
4. **Detect commands.** Kanbot reads the package manager, lockfile and scripts and proposes install, build, test and lint commands plus test-file globs, QA settings (app start command, ready URL, required services) and the env vars the project needs (names from its example env file); the owner confirms or edits them and fills in the values.
5. **Baseline run.** Kanbot runs install, build and tests once on the default branch. Failures are shown so the owner can fix them or accept them as a known baseline; agents are never blamed for failures that were already there.
6. **CI.** If no workflow exists, Kanbot opens a PR adding a starter GitHub Actions workflow built from the confirmed commands.
7. **Branch protection.** Kanbot checks the default branch and offers to apply the rules above.
8. **Hotspots** (M6). Plan B suggests hotspot groups (section 9); the owner confirms them.
9. **CLAUDE.md** (M6). If the repo has none, Kanbot drafts one (layout, commands, conventions), plus a `.claude/claude-security-guidance.md` threat-model note for the Security Guidance plugin, and opens them as a PR.
10. **Ready.** The board appears with the default columns; agents are enabled once branch protection is in place or explicitly overridden.

Built details (M5, phase 4):

- **Where each step runs.** The web app only calls GitHub's API (repo list, workflows, the CI PR, protection); it never runs git, and its repos mount is read-only. The worker clones and runs the baseline. `projects.onboarding` holds the step and its state (`queued`, `running`, `waiting` for the owner, or `failed` with the error, which the owner can retry). A `project.onboarding` event wakes the worker and refreshes the setup page (`/p/:id/setup`).
- **Step 2.** Home lists the repos of every App installation (all pages); a repo that's already a project can't be picked again. The project takes the repo's name and GitHub's default branch. A local folder (no GitHub) is still possible under "Use a local folder instead", for development and tests; such a project has no onboarding and can't ship PRs.
- **Step 3.** The clone goes to `KANBOT_REPOS_DIR/<key prefix>` (`.kanbot-repos/` at Kanbot's root under `pnpm dev`), over HTTPS with a one-hour installation token passed through git's environment, so it is never written to `.git/config`. A retry, or a key reused after deleting a project, fetches and resets Kanbot's own clone instead.
- **Step 4.** `.kanbot/project.yml` and the devcontainer come first; detection fills the commands, test globs and image they leave out. It reads the default branch's file list and `package.json`, `requirements.txt` and `pyproject.toml`:
  - Node: pnpm, yarn or npm by lockfile, with the `build`, `lint`, `test` and `start` scripts; `node:24-bookworm`.
  - Python: `pip install --user` (each command is its own container, and HOME is the shared cache volume), `python -m compileall -q .` as the build, pytest or unittest when there are test files; `python:3.12-bookworm`.
  - Go: download, build, vet and test; `golang:1.23-bookworm`.

  Other languages get no proposal; the owner types the commands. A start command is required to confirm (400 `qa_setup`, §4); the page marks it when detection found none, and the edits are saved either way. The QA ready URL and required services aren't detected (§4).
- **Environment variables (step 4, and Settings).** Projects that need API keys or connection strings get them as env vars.
  - Onboarding proposes the names in the repo's `.env.example` (or `.env.sample`, `.env.template`) with empty values; the owner fills them in or adds others.
  - Values are stored encrypted (`projects.env`, AES-256-GCM under `KANBOT_ENCRYPTION_KEY`) and are write-only: the API returns names and whether each is set, never a value.
  - Every project command gets them (owner's choice, 2026-11-07): install, the baseline, the checks gate, QA's app and the agents' own project-command calls. In the image they arrive through a 0600 `--env-file` in a fresh temp folder outside every worktree, removed when the run or step ends. On the host toolchain (development) they are added to the command's environment. Names with an empty value aren't passed.
  - `PORT`, `HOME` and `PATH` are Kanbot's and can't be set. Values can't contain newlines (docker's env file is one line per variable).
  - Values of 8 characters or more are redacted from stored run events, recorded scripts, checks reports and the baseline's output.
  - **Limit:** code an agent writes can still read and print them, so the owner should give development credentials, not production ones.
- **Step 5.** Install, build, lint and test run once in a throwaway worktree of the default branch, in the project's image, each whatever the others did. The results and output are stored in `projects.baseline`. The owner accepts them, or fixes the repo or the commands (Settings) and runs it again. **A command that failed at baseline is skipped by the checks gate (§8)**, and agents are told it was already failing (owner's choice, 2026-11-07). A new break in that same command is left to Code Review, QA and CI.
- **Step 6.** Skipped when the default branch already has workflows. Otherwise Kanbot commits `.github/workflows/kanbot-ci.yml` to the branch `kanbot/onboarding-ci` through the contents API and opens a PR, which the owner merges on GitHub. Its one job, `ci`, runs the confirmed install, build, lint and test commands in the project's image (`container:`), on pushes to `kanbot/**` and on PRs. A devcontainer that is built rather than named gives the workflow no container. The job's `env` reads each of the project's env var names from the repo's Actions secrets (`${{ secrets.NAME }}`). The owner adds them on GitHub: the CI step links there and the PR body lists them. Kanbot doesn't copy values to GitHub (owner's choice).
- **Step 7.** Protected means a PR with 1 approval, strict required status checks, and no force-push or deletion. Apply sets exactly those, **for admins too** (`enforce_admins`, owner's choice). The required check is `ci` when Kanbot's workflow is there or its PR is open, else the check names already reported on the default branch's head. A branch that is already protected keeps its own rules. GitHub refuses protection on a private repo under a free plan (403); the page shows GitHub's message, and the way on is the override.
- **Step 10.** Until a GitHub project's setup reaches Ready, moving a ticket into an agent column answers 409 `unprotected` (`startColumnAgent`), and the board shows a "Finish setup" banner. Protection isn't rechecked after Ready.

## 11. Data model

Ten tables plus a single-row `settings` table cover v1; all IDs are UUIDv7, all timestamps `timestamptz`, and JSON payloads are `jsonb` validated by shared zod schemas.

| Table | Key fields | Notes |
| --- | --- | --- |
| `projects` | id, key\_prefix, name, repo\_path, default\_branch, github\_owner, github\_repo, onboarding (jsonb: step, state, error, CI PR URL, override; null for a local folder), commands (jsonb: install, build, test, lint, QA start command and ready URL), image (the project's container image, §7), dockerfile (jsonb: the file and build context the repo's devcontainer builds, §7), env (the project's env vars, encrypted JSON, §10), test\_globs, hotspots (jsonb: name and globs per group), baseline (jsonb: each command's result and output at onboarding), settings (jsonb: budgets, concurrency, auto-moves), created\_at | `key_prefix` unique; next ticket number tracked in `ticket_seq`. These columns are null until the project's first read seeds them from the repo's `.kanbot/project.yml` (section 9); a project with no repo stays unseeded. `settings` holds `bounceLimit` (default 3, 1–10) and `concurrency` (default 1, 1–2: the worker runs 2 runs at once in all); budgets and auto-moves arrive with their first user. |
| `columns` | id, project\_id, slug, name, position, agent\_slug (nullable), wip\_limit, auto\_advance (bool) | Seeded with the default workflow per project. |
| `tickets` | id, project\_id, number, title, description\_md, type, priority, labels\[\], column\_id, position, parent\_id, branch\_name, worktree\_path, bounce\_count, status\_flag (`none`, `running`, `needs_input`, `plan_ready`, `awaiting_approval`, `waiting_on_ticket`, `pr_open`, `failed`), touch\_paths\[\], pr\_number, pr\_url, head\_sha, ci\_state (`none` = no CI workflows, `pending`, `passing`, `failing`), review\_state (`none`, `approved`, `changes_requested`), last\_review\_id (the newest GitHub review already handled, so requested changes are imported once), created\_at, updated\_at | `(project_id, number)` unique; `position` is a fractional index for ordering in a column. |
| `acceptance_criteria` | id, ticket\_id, position, text, status (`open`, `pass`, `fail`), source (`user`, `agent`) | QA updates status. |
| `ticket_links` | project\_id, from\_ticket\_id, to\_ticket\_id, kind (`blocks`, `relates`), confirmed, source (`user`, `agent`) | Epics use `tickets.parent_id`, not this table. |
| `runs` | id, ticket\_id, agent\_slug, agent\_config\_hash, column\_slug, state, verdict, summary, request\_md, session\_id, resume\_session\_id, input\_tokens, output\_tokens, cost\_usd, budget\_usd, files\_changed, created\_at, started\_at, ended\_at, error | One active run per ticket enforced with a partial unique index on non-terminal states (`queued`, `running`; `awaiting_input` is terminal, see §8 Resume). `budget_usd` is set when the run is claimed: the agent's budget, capped by what is left of the day; while the run goes, it counts toward today's spend. Also the job queue (§7). Token counts include cache reads and writes. `request_md` is the owner's Revise plan text (UC-3) or Resume answer (UC-7) the run acts on; null otherwise. `resume_session_id` is the agent session the run continues (Resume, bounce-backs). `files_changed` is what this run itself changed in the worktree, committed or not (files a previous run left dirty excluded), recorded even when the post-run checks fail; the Diff tab uses it to say who changed each file. |
| `run_events` | id, run\_id, seq, type (`assistant`, `tool_call`, `tool_result`, `stdout`, `system`), payload (jsonb), created\_at | Append-only; `(run_id, seq)` unique; pruned after 90 days except the last run per ticket. |
| `screenshots` | id, ticket\_id, run\_id, name, png (bytea), created\_at | QA's browser screenshots (§4); deleted with the ticket; `run_id` set null if the run goes. |
| `artifacts` | id, ticket\_id, run\_id, kind (`plan`, `research`, `review`, `test_report`, `blocker`, `retro`, `diff_snapshot`, `pr_description`), title, version, content\_md, data (jsonb), created\_at | New versions never overwrite old ones. An epic's plan keeps `data.proposedTickets` and `data.accepted` (ref → created ticket id); `accepted` is the one field that changes after the artifact is written. The checks gate's failures are `test_report`s titled "Kanbot checks: …". |
| `comments` | id, ticket\_id, author\_kind (`user`, `agent`), agent\_slug, body\_md, file, line, resolved, created\_at | Review line comments use `file` and `line`. |
| `activity` | id, ticket\_id, actor\_kind, actor, action (`created`, `moved`, `run_started`, `run_finished`, `commented`, `edited`, `pr_opened`, `pr_closed`, `pr_merged`, `ci_changed`, `review_imported`, `pushed`), data (jsonb), created\_at | Drives the ticket timeline and the audit trail. GitHub's events are logged with the actor `GitHub`. Criteria changes are `edited` with `fields: ["criteria"]`. |

Global settings (daily budget, global concurrency, serious mode, pause-all flag, encrypted GitHub App credentials) live in a single-row `settings` table (id 1; a missing row means the defaults). Built so far: `paused`, `paused_reason` (set when Kanbot paused itself), `daily_budget_usd` and `github_app` (the App's credentials and owner, encrypted JSON, §10); each other field arrives with its first user. Until then global concurrency is a constant in the worker (per-project concurrency is in `projects.settings`). `projects.repo_path` is an optional absolute path to a local checkout; onboarding fills it with the clone path.

## 12. API and real-time events

The web app exposes a JSON REST API under `/api` (used by the UI and a future CLI) plus one SSE stream; all bodies are validated with the shared zod schemas and errors return `{error: {code, message}}`.

### REST endpoints

| Method | Path | Purpose | Milestone |
| --- | --- | --- | --- |
| GET / POST | `/api/projects` | List or create projects. A body with `githubOwner` and `githubRepo` starts onboarding (409 `repo_taken`); otherwise `repoPath` is an optional local folder. | Built |
| GET / POST | `/api/projects/:id/onboarding` | GET: the setup page's data (step, detected settings, baseline, the repo's workflows at step 6, the missing protection rules at step 7). POST body `{action}`: `confirm-commands` (with `settings`, as in PATCH `/api/projects/:id`; 400 `qa_setup` without a start command), `retry`, `rerun-baseline`, `accept-baseline`, `open-ci-pr`, `skip-ci`, `apply-protection`, `override-protection`. 409 `wrong_step` for an action the current step doesn't take; 502 `github` with GitHub's message. | Built |
| GET | `/api/github/repos` | The repos the App's installations can see, each with `taken` when it's already a project. | Built |
| GET / PATCH | `/api/projects/:id` | Read or update project settings (commands, test globs, hotspots, bounce limit, concurrency, ticket budget, env vars). A GET seeds an unseeded project. In a PATCH, `env` is the whole set, `{NAME: value \| null}`: null keeps the stored value, and a name left out is removed. Reads return `env: [{name, set}]`, never values. | Built |
| GET | `/api/projects/:id/board` | Columns with ordered ticket cards (one call renders the board). | Built |
| POST | `/api/projects/:id/tickets` | Create a ticket. | Built |
| GET / PATCH / DELETE | `/api/tickets/:id` | Read (with criteria, latest artifacts, active run), edit, delete. | Built |
| POST | `/api/tickets/:id/move` | Body `{toColumnId, position, confirmCancel?, startAnyway?, keepPlan?, requestMd?, confirmSkip?, confirmClose?}`. Validates the transition, cancels any active run if confirmed, enqueues the column's agent. Returns 409 `unprotected` while a GitHub project's setup isn't finished (§10 step 10), 409 `qa_setup` for a move into QA on a project with no start command (§4), 409 `run_active` if a run is active and `confirmCancel` is not set, and 409 `overlap` when entering In Progress overlaps an in-flight ticket and `startAnyway` is not set (section 9). A move to Planning resets the bounce count; if the ticket has a plan it returns 409 `has_plan` unless `keepPlan` (no run, flag Plan ready) or `requestMd` (Plan B revises with it) is set. Into Ship before QA passed: 409 `skip_gates` unless `confirmSkip`. Into PR Review with no PR: 409 `no_pr`. Into Done with an open PR: 409 `pr_open` unless `confirmClose`, which closes the PR on GitHub first (502 `github` if GitHub refuses); with a run active, 409 `run_active` comes before the PR is closed, so a refused move never leaves it closed. | Built |
| GET / POST | `/api/tickets/:id/comments` | List or add comments. | Built |
| POST | `/api/tickets/:id/criteria` | Body `{text}`. Add an acceptance criterion. | Built |
| PATCH / DELETE | `/api/criteria/:id` | Body `{text?, status?}`. Edit or remove a criterion. | Built |
| POST | `/api/tickets/:id/links` | Body `{toKey, kind}`, kind `blocks`, `blocked_by` or `relates`. Adds a confirmed link; 404 for an unknown key, 400 for a self-link, 409 `link_exists`. | Built |
| PATCH / DELETE | `/api/links/:id` | PATCH body `{confirmed: true}` confirms a proposal; DELETE dismisses or removes a link. | Built |
| GET | `/api/tickets/:id/activity` | Timeline. | Built |
| GET | `/api/tickets/:id/diff` | `{branch, base, diff, truncated, comments}`: the unified diff of the ticket branch vs the default branch (`base...branch`, capped at 1 MB) and the review's line comments. | Built |
| GET | `/api/tickets/:id/runs` | Run history. | Built |
| GET | `/api/runs/:id/events?after=seq` | Paged run log (for catching up before streaming). | Built |
| POST | `/api/runs/:id/cancel` | Cancel a run. | Built |
| POST | `/api/tickets/:id/approve-plan` | Moves the ticket to the bottom of Ready, the same as dropping it there. 409 unless the ticket is in Planning, has a plan, and has no active run. | Built |
| POST | `/api/tickets/:id/approve-ship` | "Approve and ship": moves a ticket that passed QA to the bottom of Ship and starts Ship's agent (Captain Ship-It). 409 `not_approvable` unless it is in QA flagged `awaiting_approval`. | Built |
| POST | `/api/tickets/:id/revise-plan` | Body `{requestMd}`. Starts Plan B with the request (UC-3). 409 unless the ticket is in Planning, has a plan, and has no active run. | Built |
| POST | `/api/runs/:id/retry` | Start a fresh run of the same agent. If the failure moved the ticket (e.g. to Blocked), it goes back to the run's column first. | Built |
| GET | `/api/health` | Database, worker, Anthropic and GitHub status (section 8). | Built |
| GET | `/api/agents/:slug/avatar` | The agent's avatar SVG from `agents/`. | Built |
| POST | `/api/tickets/:id/accept-proposals` | Body `{refs}`. Creates the named proposals from the epic's latest plan in Backlog as its children (UC-11), with criteria, touch sets and confirmed `blocks` links between accepted tickets; returns `{created: [{ref, id, number}]}`. 409 `not_epic`, `no_proposals` or `already_accepted`; 400 `unknown_ref`. | Built |
| POST | `/api/runs/:id/resume` | Body `{answer?}`. Resume a blocked run (§8 Resume): cancels Duckworth, moves the ticket back to the run's column and continues the agent's session with the answer. 409 if the run can't be resumed or a later run replaced it. | Built |
| GET | `/api/agents` | The roster in board order: name, tagline, column, model, colour, file hash and this week's runs, success rate and average cost; an invalid file comes back as `{slug, error}`. | Built |
| GET / PUT | `/api/agents/:slug` | GET reads the file text and hash (`?version=<hash>` reads the saved text a past run used; 404 if unknown). PUT body `{text}` saves it after the file parses and keeps its `slug` and `column` (400 `invalid_agent` otherwise); written atomically, and the next run uses it. Only the agents on the default columns. | Built |
| GET | `/api/costs?groupBy=day\|agent\|ticket&from&to` | Cost, tokens and run count of runs that ended in `from`..`to` (local dates, both included; the last 30 days by default), grouped; `ticket` returns the top 50 by cost. | Built |
| GET / PATCH | `/api/settings` | Read Pause all, the pause reason, the daily cap and today's spend; body `{paused?, dailyBudgetUsd?}` pauses or resumes all agents and sets the cap. Resuming clears the pause reason. | Built |

GitHub endpoints (all M5): `POST /api/webhooks/github` receives signature-verified webhooks; `POST /api/tickets/:id/merge` merges only when GitHub reports a human approval and green checks. "Start anyway" is the move's `startAnyway` flag rather than its own endpoint. `GET /api/github/setup` starts the two-click GitHub App setup and `GET /api/github/callback` completes it (both built); `/api/auth/login`, `/api/auth/callback` and `POST /api/auth/logout` handle Sign in with GitHub (built).

### SSE stream

`GET /api/events?projectId=...` streams typed events, each with an `id` so the browser can reconnect with `Last-Event-ID`. Events are sent unnamed, and the type is the `type` field of the JSON data, so one `onmessage` handler sees them all:

- `ticket.created` — `{ticketId}`
- `ticket.moved` — `{ticketId, fromColumnId, toColumnId, position, actor}`
- `ticket.updated` — `{ticketId, fields}` (`fields` names the changed fields; `criteria` for checklist changes)
- `ticket.deleted` — `{ticketId}`
- `run.started` / `run.finished` — `{runId, ticketId, agentSlug, state, verdict?, costUsd?}`
- `run.event` — `{runId, ticketId, seq, eventType}`: ids only, because `NOTIFY` payloads are capped at 8 KB; the Live tab fetches the new lines from `GET /api/runs/:id/events?after=seq`. Sent to every client of the project (no `&runId=` filter; the board ignores them).
- `comment.created` — `{ticketId, commentId}`; `artifact.created` — `{ticketId, artifactId}`
- `notification` — `{kind, ticketId?, message}`: a ticket now waits for the owner (`needs_input`, `failed`, sent when Duckworth is done), or Kanbot paused itself (`paused`, global, no ticket). The board shows a browser notification when permitted and the tab is hidden.
- `settings.updated` — `{paused}`, sent to every project's stream; the worker stops its runs when `paused`
- `project.onboarding` — `{}`: the project's setup moved on (§10); the worker runs a queued clone or baseline, and the setup page refetches

Every route requires login: Sign in with GitHub through the Kanbot GitHub App, restricted to the owner's account. Exceptions are the login page, `/api/auth/*`, the two GitHub setup routes and Next's own assets, plus, once webhooks exist (M6), the webhook endpoint, which is authenticated by its HMAC signature instead.

Built in M5:

- **The session** is a cookie (`kanbot_session`) holding the owner's GitHub id and an expiry (30 days), signed with HMAC-SHA256 under `KANBOT_SESSION_SECRET`. It is HTTP-only and `SameSite=Lax`, and `Secure` on any host but this machine's. There's no session table: signing out clears the cookie, and changing the secret signs everyone out.
- **`apps/web/proxy.ts`** checks the cookie's signature on every request (never the database). Without a valid one, `/api/*` answers 401 `unauthorized` and pages redirect to `/login`.
- **The proxy's older rules still come first:** only a localhost Host gets in, and writes must come from Kanbot's own origin. Opening Kanbot to a domain is M6.
- **GitHub round trips** carry a one-time `state` in a short-lived cookie (CSRF). The user's OAuth token is used once, to read who signed in, and is never stored.

## 13. UI requirements

Five screens make up v1, and the board is home: at a glance the user must see which agent is working on what, and which tickets need them.

### Board (home)

- One column per workflow stage, topped with a stripe in the owning agent's color (a gate column is dashed and says "You decide"); header shows the column name, the owning agent's avatar and name, the card count and WIP limit (`3 / 4`).
- Cards carry a left stripe in their column agent's color and show key, title, type icon, priority, labels, and a status pill: agent avatar with spinner (running), amber "Needs you" (needs input or awaiting approval), red "Failed", or a bounce counter (`↩ 2`).
- Drag and drop with keyboard support; dropping into an agent column shows a toast like "Plan B is on it." Dropping a running ticket opens the cancel confirmation.
- Top bar: project switcher, quick-add input, "Needs me" count (a list of those tickets, which also offers browser notifications), today's spend vs daily cap, a health indicator (database, queue, Anthropic, GitHub), and the Pause all switch.

### Ticket drawer

Opens as a centered dialog over the board (up to 85% of the screen height, scrolling inside) with:

- Header: key, editable title, type, priority, column, branch name, PR link.
- Description (markdown editor) and acceptance-criteria checklist with pass/fail markers from QA.
- Tabs: **Activity** (timeline), **Live** (streaming run log with collapsible tool calls and terminal output, elapsed time, running cost, Cancel button), **Artifacts** (plan versions, research, reviews, test reports, retro rendered as markdown; each shows the avatar and name of the agent whose run produced it, with that agent's color down its edge), **Diff** (unified diff with Nancy's line comments inline; each file opens with a header naming the agents whose runs changed it, from `runs.files_changed`; side-by-side is M6 polish), **Comments** (agent comments show the agent's avatar, name and `file:line`).
- On an epic: Plan B's proposed tickets with checkboxes, Accept selected and Accept all, and the children with their columns and progress. A child shows which epic it is part of.
- When the ticket is Blocked: Duckworth's questions shown at the top with an answer box and a Resume button.

### Agents page

Roster cards (avatar, name, tagline, column, model, runs this week, success rate, average cost) and an editor for each agent's frontmatter and prompt with validation errors shown inline.

### Costs page

Spend by day (bar chart), by agent, and by ticket, with token counts; budget settings editable here.

### Settings

Built: a page per project (linked from the board's top bar) with commands (install, build, test, lint, and `start`, which QA runs to start the app), test globs, hotspots, bounce limit, concurrent runs and the ticket budget. Still to come: the rest of the QA settings (ready URL, required services), repo, workflow columns (Later), global concurrency, the daily budget, serious mode, notification and webhook settings. Adding a project runs the onboarding flow (section 10) as a guided wizard (built: `/p/:id/setup`).

### General

- Dark and light themes: the OS setting by default, a toggle in the top bar (and on Home and Settings) remembered per browser; responsive down to tablet width (phone is view-only in v1; approving from a phone is planned for M6).
- Optimistic UI for moves, rolled back if the server rejects the transition.

## 14. Safety, guardrails and cost controls

Agents run real commands on the server, so every agent is boxed in by its worktree, its tool allowlist, a budget, and a hard rule that nothing reaches the default branch without a human merge.

### Code and repo safety

- Agents run only inside the ticket's worktree; the main checkout is never their working directory. The one exception is a read-only agent that runs before a worktree exists (Plan B): its `cwd` is the project checkout, and its tools are read-only (`Read`, `Grep`, `Glob`), enforced by the permission hook.
- Worktrees live beside the checkout, at `<repo>.kanbot-worktrees/<KEY-n>`, on branch `kanbot/<KEY-n>-<slug>`. The worker creates them from the default branch on a ticket's first In Progress, Code Review or QA run (or reattaches the existing branch) and refuses any branch outside `kanbot/` or path outside that folder. Deleting a ticket removes its worktree and keeps its branch.
- The permission hook fences every agent to its `cwd`: file paths and globs that resolve outside it, including through symlinks, are refused, and so are shell commands that chain, redirect, substitute or name a path outside it. No agent may edit `.git` (in a worktree it is the file that names the repository; rewritten, commits would land on the default branch).
- No agent may commit or push to the default branch. Captain Ship-It pushes only the ticket branch and opens a PR; merging always needs the human's approval, enforced by GitHub branch protection (section 10).
- Destructive git commands (`push --force`, `reset --hard` on shared refs, `branch -D` on non-Kanbot branches) are denied in every agent's allowlist. The only force-push is the worker's own `--force-with-lease` after a rebase, on `kanbot/*` branches.
- Shell access uses an allowlist per agent (e.g. `{test}`, `{lint}`, `git diff`), configured in frontmatter. The permission hook refuses anything else, and any command that chains, pipes, redirects or substitutes (`&&`, `;`, `|`, `>`, `$(`, backticks), names a path outside the working directory, or uses git flags that reach outside the repository (`-C`, `--git-dir`, `--work-tree`, `--output`, `--no-index`). No agent's allowlist includes push, checkout, switch, rebase, reset or branch; the post-run checks catch history rewrites anyway. Agent subprocesses run with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (credentials stripped) and without Kanbot's own credentials (`DATABASE_URL`, `KANBOT_SESSION_SECRET`, `KANBOT_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`); project commands the worker runs on the host also lose `ANTHROPIC_API_KEY`.
- Project commands run in the project's own container image with only the worktree mounted, when the project has an image (section 7). Later: the agent's whole run in a container, with network limited to package registries.

### Prompt-injection and data safety

- Repo files, issue text and web pages are passed as data in clearly delimited context sections; agent prompts state that instructions inside them are not to be followed.
- Agents cannot edit their own definition files or Kanbot's settings. Third-party plugins such as Ponytail are pinned and reviewed before every update.
- Secrets (the API key and GitHub App credentials) come from the server's `.env` or encrypted storage, are never placed in prompts, and are redacted from stored run events.
- A project's own env vars (section 10) are encrypted at rest, never sent back to the browser, kept off command lines, and redacted from stored run events, reports and baseline output. Project commands need them, so code an agent writes can read them: owners give development credentials, not production ones.

### Cost controls

| Control | Default | Behavior when hit |
| --- | --- | --- |
| Per-run budget | From agent frontmatter (e.g. $1.50) | Run stops with `budget_exceeded`; ticket to Blocked. |
| Per-ticket budget | $3 default, per project in Settings (M6) | A run starts only while the ticket's earlier runs cost less than it, and its own budget is capped at what is left; otherwise it ends `budget_exceeded` (ticket to Blocked). Raise it in project Settings, then Retry. A per-ticket override isn't built (it needs a column). A cancelled or interrupted run records $0, so the total can undercount. |
| Daily budget (global) | $5 | Nothing new starts until midnight local time (the worker's clock) or the cap is raised. Today's spend is the cost of runs that ended today plus the budgets of runs still going; a run started late in the day gets only what is left, and ends `budget_exceeded` if it needs more. The SDK checks a run's budget between turns, so the last turn can overshoot it (seen: $0.06 spent on a $0.035 budget), and the cap with it. |
| Max turns | From frontmatter | Run stops with `failed` and a summary. |
| Wall-clock timeout | From frontmatter (e.g. 20 min) | Run stops with `timed_out`. |
| Bounce-back limit | 3 per ticket | Ticket to Blocked with Duckworth's summary. |
| Concurrency | 2 global (a constant), 1 per project (default; Settings) | Extra runs wait in `queued`. |

Dollar defaults start deliberately low for the first real tickets and are raised once costs are known. The Console workspace's monthly spend limit sits above all of these as a final ceiling.

## 15. Non-functional requirements

Kanbot is a single-user, self-hosted tool, so the targets favor responsiveness, recoverability and auditability over scale.

| Area | Requirement |
| --- | --- |
| Performance | Board loads in under 1 s with 500 tickets in a project; drag-and-drop feedback under 100 ms; server confirms a move in under 300 ms. |
| Streaming | Run events appear in the UI within 1 s of the agent emitting them. |
| Reliability | No ticket or run is lost on a crash or restart; interrupted runs are detected on worker start. Database backups via a documented `pg_dump` cron. |
| Auditability | Every move, run, verdict, comment and config version is recorded with actor and timestamp; run logs are kept for at least 90 days. |
| Portability | Running: Docker Compose on Linux with rootless Docker, in WSL on the owner's PC or on one Ubuntu server. Development: Windows, macOS or Linux with Node 23.6+ (the sample repo runs TypeScript directly) and PostgreSQL 16. So far tested on Windows only. |
| Security | Loopback only in WSL; on a server, public HTTPS only (Caddy) and a firewall that restricts SSH; Sign in with GitHub limited to the owner; secrets only from env and never passed to agent shells. |
| Accessibility | Board operable by keyboard (dnd-kit keyboard sensor); color is never the only status signal (pills also carry text or icons). |
| Code quality | TypeScript strict mode, type-aware ESLint, Prettier, knip; unit tests for the transition engine, verdict handling and budget logic; Playwright against a production build; a coverage floor for worker and shared; unit tests for the web app's session signing and proxy; a test that scans the whole tree for convention drift (`repo-rules.test.ts`), including tests that never run: no unconditional skip, and every conditional skip on a pinned list. Tests can't reach a real service (`fetch` to a non-loopback host throws; GitHub defaults to a dead local port). CI is one GitHub Actions workflow (`ci.yml`): every PR and push to main runs the same checks, each a command that also runs locally, and its `check` and `images` jobs are the required checks on `main`. On a PR it also reads what CI can't judge: the checks that read the PR (until real data exists, migrations may be rewritten, so editing one isn't checked; add that check back then) are warnings that never fail, listed for the owner's review (the checks' own config, the security boundary files, existing replay fixtures, deleted test files, agent files that need `pnpm eval:agents`, and `package.json`). GitHub's own secret scanning, push protection, Dependabot (minor and patch updates grouped, each major in its own PR) and CodeQL cover secrets and dependencies. The owner reviews and merges every PR. AI sessions on this repo run a local Claude Code hook (kept out of the repo) that refuses merges, label changes, repo-rule edits, force pushes and skipped git hooks; it stops accidents and is not a security boundary, because the session uses the owner's token. |
| Extensibility | Adding an agent = adding one markdown file and assigning it to a column; no code change. |

## 16. MVP scope and milestones

Build in six milestones (plus M4.5, inserted on 2026-11-05), each ending in something usable, so agents are added onto a board that already works rather than all at once.

1. **M1 — Board without agents.** *(Done.)* Monorepo scaffold, Docker Compose, Postgres + Drizzle schema and migrations, project creation, tickets with criteria and comments, drag-and-drop board with the default columns, activity log, SSE for moves. *Done when:* tickets can be created and moved and the board updates live in two browser tabs.
2. **M2 — Orchestrator and Plan B.** *(Done.)* Runs-table queue, worker process, `AgentRuntime` adapter on the Claude Agent SDK, agent file loader, context assembly, `report_result` tool, run events streamed to the Live tab, cancel and retry, per-run budget, the replay runtime for tests, API retry with backoff, and the health indicator. *Done when:* moving a ticket to Planning produces a plan artifact and a "Plan ready" flag.
3. **M3 — Build loop.** *(Done.)* Worktree manager, Sir Codes-a-Lot, Nitpick Nancy, Testy McTestface, transition table with auto-moves and bounce-backs, bounce limit, diff viewer, post-run path checks, touch sets, hotspot groups, the serialize overlap check, Nancy's cross-ticket review, stall detection (repetition), the plugin loader with Ponytail, the sample repo, recorded runs and the golden-ticket quality check. *Done when:* a small feature goes Ready → In Progress → Review → QA on its own, including at least one bounce-back.
4. **M4 — Unblock (local).** *(Done.)* Blocked column with Rubber Duckworth, resume with answer, Archie's retro and worktree cleanup, in-app notifications, cost tracking and daily cap, Pause all, project Settings in the database, ticket links. Still local: no GitHub, no deployment. *Done when:* a `needs_input` run can be answered and resumed, Pause all and the daily cap stop new runs, and a ticket moved to Done gets Archie's retro and loses its worktree.
   - **M4.5 — Quality gates and epics (local).** *(Done.)* The checks gate after Sir Codes-a-Lot (§8), Nancy's security pass with the vendored security-audit skill (§8), and epics: Plan B splits an epic or a technical doc into proposed tickets the owner accepts (UC-11). Pulled forward from M6: epics and `proposedTickets`. *Done when:* a branch that fails its tests goes back to Sir Codes-a-Lot before review, Nancy runs the security skill, and an epic's accepted proposals land in Backlog as linked children.
5. **M5 — Ship and deploy.** *(Done 2026-11-10. Auto-rebase when main moves, below, moved to M6.)* Running Kanbot in its own WSL distro (section 7; a public server moved to M6) with Sign in with GitHub and the nightly disk cleanup; **project commands and the QA app in each project's own container image (section 7, "Project toolchains"), built first, since without it the server can only build, test and run Node projects**; the onboarding walkthrough (section 10) with GitHub App connection and branch-protection check, Captain Ship-It with PR creation, CI status tracking, the PR Review gate with review-comment bounce-backs, merge detection, auto-rebase when main moves. Also owns its rows in "Still to build" below. *Done when:* a ticket goes from Backlog to a human-approved, merged PR.
6. **M6 — Polish (Later items).** Dr. Rabbit Hole and spikes, epics with child tickets, auto-pull from Ready, Marge Conflict, stacked branches, Agents and Costs pages, editable workflow columns, webhooks, container mode, approving from a phone (plans, ship, Blocked answers, pause all), and the kanbot CLI.

MVP = M1 through M5. Everything runs on the owner's PC: M5 moved Kanbot into its own WSL distro and polls GitHub instead of receiving webhooks; a public server is optional (M6).

### Still to build

Everything the spec describes that isn't built yet, with the milestone that builds it. Whoever builds that milestone owns the row. Anything deferred, cut or moved goes here in the same change. Finished rows are deleted.

**M6**

| Item | Spec | Notes |
| --- | --- | --- |
| Check rebasing with two real tickets in flight while main moves | §9, FR-51 | Built in M6 phase 1 and tested against local repos and the GitHub stub; not yet tried on a real repo (owner's call, e.g. Neural-Noir-Website). |
| `blockWritesOutsideWorkingDirectories` | §7, §14 | Moved from M5 on 2026-11-10. Needs Claude Code 2.1.314; the pinned SDK bundles 2.1.304. Writes are fenced by the permission hook and the post-run checks meanwhile. |
| SDK `sandbox` | §7, §14 | Moved from M5 on 2026-11-10. Linux/macOS only (dev is Windows; Kanbot itself runs on Linux in WSL). |
| SSE `Last-Event-ID` replay | §12 | Moved from M5 on 2026-11-10. Only if needed: the board refetches on reconnect and the Live tab pages `/api/runs/:id/events?after=seq`. Revisit when running over real networks. Marked with a `shortcut:` comment. |
| Checking rootless Docker in the owner's `kanbot` WSL distro | §7 | Moved from M5 on 2026-11-10. The files and `docs/deploy.md` (setup A) exist; the stack was checked in WSL on rootful Docker. Needs `sudo`, so the owner sets the distro up; rootless Docker's host network and a real SDK run as container root (paid, ask first) are still unchecked. |
| A stub-backed GitHub project in the golden-ticket eval, so Ship-It is evaluated | §8 | Moved from M5 on 2026-11-10. The eval's golden tickets use local projects, where Ship stays a gate. One paid run, with the owner's OK. |
| A public server: Caddy, HTTPS, webhooks, the deploy workflow on a real host | §7, FR-44 | Moved from M5 (2026-11-06): Kanbot runs locally in WSL for now. The files and `docs/deploy.md` (setup B) exist; checking them needs a server and a domain. Login exists (M5), but `proxy.ts` still answers only on localhost. A server also needs:
- the domain allowed in the proxy;
- `X-Forwarded-Proto` trusted from Caddy, for the cookie and the App's URLs;
- the App's webhook and events added, with its callback URLs for the domain;
- the first setup done over an SSH tunnel. |
| Agent files for Dr. Rabbit Hole and Marge Conflict | §4, §9 | Until Marge ships, every conflicting rebase goes to Blocked. |
| Onboarding steps 8–9: Plan B suggests hotspot groups; Kanbot drafts CLAUDE.md and `.claude/claude-security-guidance.md` as a PR | §10 | Moved from M5 on 2026-11-06: not needed for M5's done-when, and each is agent work with its own eval spend. Hotspots are edited in Settings meanwhile. |
| Agents page: add a new agent (or a new column with one) from the UI; a field-by-field editor; the Costs page's chart as a library chart | FR-31, §13, UC-14 | M6 phase 3 built the pages with existing agents only, a plain textarea over the whole file, and CSS bars. Old runs have no config hash. Cost by ticket shows the top 50, and its total covers those. |
| A Merge button in Kanbot, enabled once a human approval exists | §10, FR-47 | Owner's choice (2026-11-07): merging happens on GitHub; Kanbot detects it (M5 phase 5b). |
| The PR Review "small fix" checkbox: a requested change skips Code Review and QA | §10 | Owner's choice (2026-11-07): requested changes always go back through Code Review and QA for now. |
| Side-by-side diff view | §13 | The Diff tab is unified. |
| `columns.wip_limit`, `auto_advance`; WIP display and enforcement | FR-20, FR-22 | The only approval gate so far (QA → Ship) stays a gate; the concurrency limits already cap parallel runs. WIP limits matter most with auto-pull (M6). Moved from M4 on 2026-11-03. |
| Running cost while a run works | UC-8, §13 | The SDK reports cost only when a run ends (per-turn messages carry tokens, not dollars), so a live figure needs Kanbot's own price table. The drawer shows elapsed time live and cost at the end; today's spend counts a running run's budget. A cancelled or interrupted run never gets the SDK's final result, so it records $0 for what it spent; the same price table would fix that. Moved from M4 on 2026-11-03. Marked with a `shortcut:` comment. |
| QA ready URL and required services; a Playwright test setup added by onboarding (PR) and run by the starter CI | §4 "How QA runs" | Testy's browser is built (M5): it checks pages live, but can't commit browser tests to a project without a Playwright setup. Readiness is any HTTP answer on `/`, and services such as a test database aren't started. Desktop (GUI) apps can't be driven at all, and QA requires a start command (§4), so a desktop project's QA can't pass yet: driving one needs a virtual display (Xvfb) with screenshots. |
| TypeScript LSP, Context7 and Security Guidance plugins | §8 | Each adds context to every turn, so each is added once the golden-ticket eval can compare it on and off. Moved from M4 on 2026-11-03. |
| Stall detection: repeated feedback (same issue raised on a second bounce) | §8 | Needs fuzzy matching; the bounce limit already stops the loop. Moved from M4 on 2026-11-03. |
| Multi-line project env var values (PEM keys, JSON credentials) | §10 "Environment variables" | Refused today: docker's `--env-file` is one line per variable. Base64 the value meanwhile. Upgrade by mounting each value as a file or encoding it, when a project needs one. |
| Projects other than web apps (desktop/GUI apps, command-line tools, libraries, services without HTTP) | §4 "How QA runs", §10 step 4 | Owner's goal (2026-11-07): Kanbot should work on any kind of project, not only web apps. Today QA requires a start command and an app that answers HTTP, so other projects can't get through QA. Each kind needs its own way for Testy to use it: a virtual display (Xvfb) with screenshots and input for desktop apps, running the CLI with arguments and reading its output, calling a library from a test harness. Onboarding would ask what kind of project it is and which of these applies. |

Known shortcuts are also marked in code with `shortcut:` comments (list them with `/ponytail-debt` or `git grep -n "shortcut:"`).

## 17. Open questions and notes for Claude Code

Nearly everything is decided; Claude Code builds to the Decided list below unless the owner changes it.

### Decided

- **Language:** TypeScript end to end (section 7). No Python; no Rust in v1.
- **Hosting:** Docker Compose in a dedicated WSL distro on the owner's PC; a public server (any Ubuntu VPS, with Caddy) is optional and later (section 7, decided 2026-11-06).
- **Agent authentication:** a Claude Console API key, pay per token. Kanbot gets its own Console workspace with a monthly spend limit as a hard ceiling, prepaid credits and auto-reload off. If the owner later moves to a plan with monthly API credits, linking the same Console organization covers this key with no change to Kanbot.
- **Budget defaults:** start low at $3 per ticket and $5 per day, plus the per-agent run budgets in each agent file; raise them once real ticket costs are known.
- **QA's job:** check that the branch meets its acceptance criteria, with evidence from the running app, tests or code; regressions are the checks gate's and CI's (decided 2026-11-05, section 4).
- **Project toolchains:** each project's commands run in its own container image from M5 (section 7); Kanbot never installs language toolchains (decided 2026-11-05).
- **Container isolation (the agent's whole run, network limits):** stays Later. Kanbot is single-user and works only on the owner's own repos with dependencies the owner chose; the MVP relies on rootless Docker, scrubbed agent environments, the firewall and login. Revisit before pointing Kanbot at repos with unfamiliar dependencies or opening it to other users.
- **GitHub identity:** a GitHub App created through the two-click setup (section 10). The same app provides Sign in with GitHub.
- **Approval gates:** only plan, ship and merge wait for the owner; manual moves behave as in section 3.
- **Models:** per-agent defaults in section 4, tuned once cost data comes in.
- **Overlap policy:** serialize by default; hotspot overlap always serializes (section 9).
- **QA:** HTTP checks and a headless browser against the worker-started app, with Kanbot's own browser tools rather than the Playwright plugin (section 4, decided 2026-11-07).
- **Plugins:** Ponytail, Security audit (Cloudflare's skill, for Nancy; decided 2026-11-05), TypeScript LSP, Context7 and Security Guidance, pinned and bundled (section 8). Playwright is replaced by Kanbot's own browser tools (2026-11-07).
- **Phone approvals:** planned for M6, not the MVP.

### Still open

- [ ] **Name.** Keep "Kanbot" or pick another.

### Instructions for Claude Code

- Work milestone by milestone (section 16); stop at the end of each for review.
- Before writing agent-runtime code, check the current Claude Agent SDK package name, API, plugin loading and permission-hook mechanism in its official docs rather than relying on memory.
- Keep the transition table as data in `packages/shared` and cover it with unit tests using the replay runtime, so CI never calls the real API; it is the heart of the system.
- Keep this document in the repo as `docs/requirements.md` and update it in the same PR whenever a decision or behavior changes.
- Do not introduce Python in any part of the project, including scripts and tooling.
- Ship each agent's file in `agents/`, with a placeholder SVG avatar, in the milestone that wires that agent up (see "Still to build" in section 16). Draft each system prompt carefully and flag it for the owner's review before its milestone closes; prompt quality decides agent quality.
- Keep a `.env.example` listing every variable; never commit secrets, and never use real credentials in tests.
