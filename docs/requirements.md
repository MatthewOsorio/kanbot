# Kanbot — Technical Requirements

Last updated 2026-11-03.

## Where things stand

- **Built (M1–M3, merged):**
  - The board: projects, tickets, criteria, comments, activity, drag and drop, live updates over SSE.
  - The worker: a runs-table queue, the Claude Agent SDK runtime behind a permission-hook fence, and a replay runtime for tests.
  - Four agents work the build loop:
    - Plan B (Planning);
    - Sir Codes-a-Lot (In Progress), in a worktree per ticket;
    - Nitpick Nancy (Code Review), with cross-ticket review;
    - Testy McTestface (QA).
  - Bounce-backs and the bounce limit, the overlap check, stall detection (repetition rule), Ponytail, and the golden-ticket eval.
- **How it runs:** locally only, bound to 127.0.0.1, with no login. Tested on Windows only. Project commands, test globs and hotspots come from `.kanbot/project.yml`.
- **Next: M4 (unblock, still local).**
  - Built so far: the daily cap, Pause all, automatic resume after an outage, CI.
  - Still to come: Rubber Duckworth with resume, Archie, costs per ticket.
  - Project Settings, ticket links, notifications, the remaining stall rules.
- **Then M5 (ship and deploy):** the server and login, the GitHub App, Captain Ship-It, CI and the PR Review gate.

The rest of this document is the target design. Anything not built yet is listed in §16 "Still to build", with the milestone that builds it. What each milestone built, and why, is in `docs/m1-report.md`, `m2-report.md` and `m3-report.md`.

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
- Hosting as SaaS for other people. It runs on the owner's own DigitalOcean Droplet.
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
| Ready | Overlaps an in-flight ticket (section 9) | The move is refused (409 `overlap`) and the ticket stays in Ready; the owner is asked to "Start anyway". Dependencies (`blocks` links) join this check in M4 | Yes; user can "Start anyway" |
| In Progress | `success` | Code Review | Yes |
| Code Review | `success` | QA / Testing | Yes |
| Code Review | `changes_requested` | In Progress, review comments attached, bounce +1 | Yes |
| QA / Testing | `success` | Stays in QA, flagged `awaiting_approval`; dragging to Ship is the approval | Approval gate by default |
| QA / Testing | `failed` reported by Testy | In Progress, test report attached, bounce +1. A QA run that fails without reporting (crash, max turns) goes to Blocked like any other | Yes |
| Ship | PR opened and CI green | PR Review | Yes |
| Ship or PR Review | CI fails | In Progress, failing log attached, bounce +1 | Yes |
| PR Review | Human requests changes | In Progress with the review comments (not counted toward the bounce limit) | Yes |
| PR Review | Human merges | Done (starts Archie) | Yes |
| PR Review | PR closed without merging | Backlog | Yes |
| Any column with a branch | Main moved and the rebase conflicts | Stays put while Marge Conflict resolves; on success goes to Code Review | Yes |
| Any agent column | `needs_input`, `failed`, `timed_out`, `budget_exceeded`, or bounce limit reached | Blocked (starts Rubber Duckworth) | Yes |
| Blocked | User answers and clicks Resume | The column the ticket came from; that agent resumes its session | No |

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
| Ship | Counts as ship approval; Captain Ship-It opens or updates the PR. Skipping Code Review or QA asks you to confirm first. |
| PR Review | If a PR exists, the ticket waits for your review; if not, you're asked whether to run Ship first. |
| Done | If the PR is merged, Archie runs. If not, you confirm closing without merging; the PR is closed, the branch kept, and Archie runs. |
| Blocked | Rubber Duckworth summarizes where things stand, so a parked ticket keeps its context. |

Moving a ticket with an active run cancels that run first (FR-24). No manual move merges code; merging always goes through GitHub's protected path.

## 4. Agent roster

Nine agents ship in v1: one per working column, plus a researcher, an unblocker and a conflict mediator; each is a config file the user can edit, rename or replace.

| Agent | Column | Job | Tool access | Produces |
| --- | --- | --- | --- | --- |
| **Plan B** — "Always has a backup plan." | Planning | Turns a rough idea into a spec: problem statement, acceptance criteria, implementation plan, files likely touched (the touch set), risks, size estimate. Flags related or dependent tickets. Splits epics into child tickets. | Read-only repo (read, search, list). No edits, no shell. | Plan artifact (markdown), acceptance-criteria checklist, touch set, proposed links and child tickets |
| **Dr. Rabbit Hole** — "Went looking for one answer, came back with twelve." | Planning (spike tickets only) | Researches a question: compares libraries, reads docs, prototypes in a scratch dir. Answers with a recommendation. | Read-only repo, web search/fetch, write only inside a scratch folder. | Research report with recommendation and sources |
| **Sir Codes-a-Lot** — "Knighted for services to the keyboard." | In Progress | Implements the approved plan in the ticket's worktree; writes unit tests; runs build, lint and tests; commits in small steps. On bounce-back, addresses review comments, bug reports, CI failures or the human's PR review. | Full edit in worktree, shell (allowlisted commands), git commit (no push). | Commits on the ticket branch, implementation notes |
| **Nitpick Nancy** — "Has opinions about your semicolons." | Code Review | Reviews the branch diff against the plan and acceptance criteria: correctness, readability, security, missing tests, scope creep, and changes that would break other in-flight tickets (section 9). | Read-only repo, git diff/log, can run linters. No edits. | Review artifact with line comments; verdict approve or changes requested |
| **Testy McTestface** — "Breaks things professionally." | QA / Testing | Runs the full test suite, writes integration or end-to-end tests for each acceptance criterion, does exploratory checks (e.g. starts the app and hits endpoints). | Edit test files only (enforced by path globs), shell (allowlisted), a headless browser through Playwright. | Test report: pass/fail per criterion, bug reports with repro steps |
| **Rubber Duckworth** — "Quack. Tell me where it hurts." | Blocked | Summarizes why a ticket is stuck, what was tried, and the exact questions the human must answer. Suggests options. | Read-only ticket history and repo. | Blocker summary with numbered questions |
| **Captain Ship-It** — "Fortune favors the merged." | Ship | Re-runs tests on the rebased branch, writes the PR description and changelog entry, updates docs/README if needed, pushes the ticket branch, opens a PR, then waits for CI. | Edit docs and changelog, git push to ticket branch, GitHub PR create. Never pushes to or merges into the default branch. | Pull request link, changelog entry |
| **Archie the Archivist** — "Remembers everything so you don't have to." | Done | Writes a short retro (what was built, cost, bounce-backs, lessons), suggests additions to the project's CLAUDE.md, cleans up the worktree. | Read ticket history, delete own worktree. | Retro artifact, CLAUDE.md suggestions |
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

Testy McTestface checks each ticket in four steps:

1. **Run the existing tests** and compare with the baseline from onboarding; anything newly failing is this ticket's bug.
2. **Write a test per acceptance criterion.** Logic and API criteria get unit or integration tests in the project's own framework; criteria about what a user sees or does get Playwright end-to-end tests. Tests are committed to the branch, so CI reruns them from then on.
3. **Explore.** Start the app from the worktree on the ticket's own port and drive a real browser through Playwright's MCP server, looking for console errors, broken layouts and dead buttons. For APIs, make real HTTP requests.
4. **Report** pass or fail per criterion, with screenshots attached to the ticket and bug reports with repro steps.

Projects without a UI skip the browser steps.

- QA settings per project (app start command, ready URL, required services such as a test database) are detected during onboarding.
- The worker gives each ticket its own port through a `PORT` environment variable, so two tickets' apps never collide.
- The worker image includes headless Chromium for Playwright.
- If a project has no Playwright setup, onboarding adds it through a PR; Testy only edits test files.
- The starter CI workflow runs the Playwright tests too.

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
| UC-7 | Agent needs input | Any agent returns `needs_input`, or the bounce-back limit is hit. | Ticket moves to Blocked; Rubber Duckworth posts numbered questions; user gets a notification. User answers in a comment and clicks Resume; the ticket returns to its previous column and the agent resumes. |
| UC-8 | Watch an agent work | User opens a ticket with an active run. | Live stream of the agent's messages, tool calls and command output; elapsed time and running cost shown. |
| UC-9 | Ship and close | QA passes; user approves Ship (or auto-ship is on). | Captain Ship-It opens a PR; once CI is green the ticket waits in PR Review. When the owner approves and merges, the ticket moves to Done; Archie writes the retro and removes the worktree. |
| UC-10 | Research spike | User creates a ticket of type `spike` and moves it to Planning. | Dr. Rabbit Hole runs instead of Plan B and returns a recommendation; the user can convert it into feature tickets. |
| UC-11 | Break down an epic | Plan B plans a ticket of type `epic`. | Plan proposes child tickets; user accepts some or all; children are created in Backlog linked to the epic. Epic shows child progress. |
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
| FR-14 | Parent/child links (epic → children) and "blocked by" dependencies; a ticket blocked by an unfinished ticket cannot enter In Progress. | MVP |
| FR-15 | Quick-add from anywhere (keyboard shortcut) and from a CLI command `kanbot add "idea"`. | Later |

### Board and transitions

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-20 | Drag-and-drop board with columns, card counts and WIP limits per column. | MVP |
| FR-21 | Moving a ticket into a column with an agent enqueues a run for that agent. | MVP |
| FR-22 | Agent verdicts drive automatic moves per the transition table (section 3). Each auto-move can be switched to "stay and wait for approval" per column. | MVP |
| FR-23 | Bounce-back limit per ticket (default 3 combined Code Review, QA and CI bounces; the owner's own PR review requests don't count); exceeding it moves the ticket to Blocked. | MVP |
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
| FR-42 | Bot identity via the Kanbot GitHub App, created from a manifest in two clicks; commits carry `Kanbot-Agent` and `Kanbot-Ticket` trailers. | MVP |
| FR-43 | Captain Ship-It pushes the ticket branch and opens a PR; PR number, URL and head SHA stored on the ticket. | MVP |
| FR-44 | GitHub webhooks (signature-verified) for PRs, reviews, review comments, checks and pushes to main, with 60 s polling as a fallback. | MVP |
| FR-45 | Project setup verifies branch protection on the default branch (PR required, 1 approval, required checks, no force-push) and offers to apply it; agents stay disabled on unprotected projects unless overridden. | MVP |
| FR-46 | CI status shown on cards and in the drawer; failing CI bounces the ticket to In Progress with a log excerpt. | MVP |
| FR-47 | PR Review gate: human review comments are imported, "changes requested" bounces to In Progress, and the Merge button is enabled only after a human approval. | MVP |
| FR-48 | Commits pushed by the human to a ticket branch are detected and never rewritten; the next run starts from the latest head. | MVP |
| FR-49 | Remove the worktree when a ticket reaches Done or is deleted; keep the branch until merged. | MVP |
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
| Job queue | The `runs` table itself: the worker claims `queued` rows with `FOR UPDATE SKIP LOCKED`, woken by `NOTIFY` (5 s poll as backup) | Durable, no Redis and no second job record to keep in sync with the run; the concurrency limits are one SQL condition. (pg-boss was the original choice; dropped in M2.) |
| Agent runtime | Claude Agent SDK (TypeScript), behind an `AgentRuntime` adapter | Same agent loop and tools as Claude Code; adapter keeps other backends possible. |
| Git | `git` CLI via `git()` in `packages/shared/src/repo.ts` (`execFile`, no shell) | Worktrees, branches, diffs, commits. |
| GitHub | Octokit | Push status, PR creation, merge detection. |
| Live updates | Server-Sent Events from the web app, fed by Postgres `LISTEN/NOTIFY` from the worker | One-way streaming is all the board needs; simpler than WebSockets. |
| Validation | zod | Agent frontmatter, verdict payloads, API bodies. |
| Testing | Vitest (unit), Playwright (UI end to end) | Fast, TypeScript-native. |
| Deployment | Docker Compose: `caddy`, `web`, `worker`, `db` | One DigitalOcean Droplet, with Caddy in front for HTTPS (see Deployment below). |

### Process responsibilities

- **Web (`apps/web`)**: renders the board, serves the REST API, validates transitions, writes ticket moves, enqueues run jobs, streams events to the browser over SSE.
- **Worker (`apps/worker`)**: consumes run jobs, manages worktrees, assembles context, runs agents through the runtime adapter, persists run events, applies verdicts (moves tickets), enforces budgets and concurrency.
- **Database**: source of truth for projects, tickets, runs, events, artifacts and costs; the `runs` table doubles as the job queue; `NOTIFY` channel `kanbot_events` carries live updates and wakes the worker.
- **`agents/` folder**: one markdown file per agent, checked into the Kanbot repo and overridable per project at `<repo>/.kanbot/agents/`.

### Deployment on DigitalOcean

Production runs on one DigitalOcean Droplet with Docker Compose, reachable at an HTTPS subdomain, so GitHub can send webhooks straight to it.

- **Droplet.** Ubuntu LTS, at least 2 vCPUs and 4 GB RAM; 8 GB is safer with two agents running builds and tests at once. A Block Storage volume holds Postgres data and cloned repos so they survive a Droplet rebuild.
- **Containers.** `caddy` (reverse proxy with automatic HTTPS), `web`, `worker`, `db` (Postgres 16). DigitalOcean Managed PostgreSQL can replace `db` later.
- **Domain.** An A record (e.g. `kanbot.<your-domain>`) points at the Droplet; Caddy obtains the TLS certificate.
- **Network.** A Cloud Firewall opens 80 and 443; SSH (22) only from the owner's IP with key auth. Postgres is never exposed.
- **Repos.** Projects are cloned from GitHub into `/srv/kanbot/repos/<project>` with the GitHub App token; worktrees live beside them.
- **Secrets.** The Anthropic API key, the session secret and the encryption key for the stored GitHub App credentials live in a root-readable `.env` passed to the containers. Agent shell commands run with a scrubbed environment that excludes them.
- **Isolation.** The worker runs as a non-root `kanbot` user. Because the server is public and agents run `npm install` and test scripts, per-run containers (section 14) are recommended before pointing agents at repos with untrusted dependencies.
- **Backups.** Nightly `pg_dump` to DigitalOcean Spaces, plus Droplet backups if enabled.
- **Deploys.** A GitHub Actions workflow in the Kanbot repo builds images and redeploys over SSH on pushes to main.

## 8. Agent orchestration and runtime

Every ticket move that lands in an agent column becomes a queued `runs` row; the worker runs the agent in the ticket's worktree, streams its events, and acts on the verdict the agent reports through a required tool call.

### Agent definition file

Each agent is `agents/<slug>.md`: YAML frontmatter for config, markdown body for the system prompt. Frontmatter is validated with zod each time a run starts; a run whose agent file is invalid fails with the validation error (the Agents page shows it once that page exists, M6). A missing file means the column is a gate.

In `tools`, `{install}`, `{build}`, `{test}` and `{lint}` expand to the project's commands from `.kanbot/project.yml` (an entry whose command the project lacks is dropped). `Bash(cmd:*)` and `Bash(cmd *)` allow `cmd` with any arguments; `Bash(cmd)` allows exactly `cmd`. Project commands must each be one plain command (no `&&`), because the permission hook refuses chained commands.

```markdown
---
slug: nitpick-nancy
name: Nitpick Nancy
tagline: Has opinions about your semicolons.
avatar: avatars/nitpick-nancy.svg
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

Before raising any level, compare the same tickets with Ponytail on and off using the replay and smoke suites: bounce count, cost and diff size.

### Other bundled plugins

Four more plugins ship in the worker image, each enabled only for the agents that benefit; every plugin adds context to every turn, so the set stays small. M3 ships only Ponytail (vendored in `plugins/ponytail/`); these four arrive in M6, each added once the golden-ticket eval can compare it on and off.

| Plugin | Source | Agents | Notes |
| --- | --- | --- | --- |
| TypeScript LSP | Official Anthropic marketplace | Sir Codes-a-Lot, Marge Conflict, Nitpick Nancy, Plan B | Real code intelligence (definitions, all references) instead of text search; makes Nancy's cross-ticket checks exact. The worker image includes the language server. For non-TypeScript projects, onboarding enables the matching official LSP plugin instead. |
| Context7 | Partner (MCP) | Plan B, Sir Codes-a-Lot, Dr. Rabbit Hole | Current library documentation, so agents don't code against outdated APIs. Calls an external service, so the worker's network allowlist includes it. |
| Security Guidance | Official Anthropic marketplace | Sir Codes-a-Lot, Nitpick Nancy | The agent reviews its own changes for common vulnerabilities and fixes them in the same run. Uses the project's `.claude/claude-security-guidance.md`, which onboarding drafts. |
| Playwright | Official Anthropic marketplace | Testy McTestface | Browser automation and end-to-end tests for QA (section 4). |

**Candidates for later:** code-review (an optional deep review Nancy triggers only for large or risky diffs, since it runs several parallel agents), chrome-devtools-mcp (console and network debugging for Testy), and Sentry (turning production errors into tickets).

**Deliberately not used:** workflow plugins such as Superpowers and feature-dev, because the board is the workflow; GitHub and commit plugins, because agents never touch GitHub directly; and memory plugins, because Archie's CLAUDE.md suggestions cover what carries between tickets.

### Run lifecycle

1. **Enqueue.** The web app writes the move and creates a `run` row in state `queued` in the same transaction; its `NOTIFY` wakes the worker. Only one active run per ticket (partial unique index); a new move cancels the old one first.
2. **Prepare.** The worker claims the oldest queued run that fits the concurrency limits (global default 2, per-project default 1) in one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` under an advisory lock and sets state `running`. For In Progress, Code Review and QA runs it creates or reuses the ticket's worktree (section 14), running the project's install command when it creates one. If install fails, the worker removes the new worktree again (the branch stays) and the run fails, so the next run installs from scratch.
3. **Assemble context.** The worker builds the prompt from: ticket fields, acceptance criteria, latest plan artifact, summaries of the last 3 runs, unresolved review comments or bug reports, user comments since the last run, the project CLAUDE.md, and the git diff stat. Large items are truncated with a pointer to the file in the worktree.
4. **Execute.** The runtime adapter starts the agent with `cwd` = worktree (before a worktree exists, as for Plan B: the project checkout, read-only), only the agent's built-in tools, its system prompt, and a custom `report_result` tool that is always loaded. A `PreToolUse` hook refuses any call outside the frontmatter `tools`, any file path or glob that resolves outside `cwd` (symlinks followed), any Edit/Write outside the agent's edit scope, and any shell command that isn't one plain invocation matching the agent's `Bash(...)` allowlist (the SDK auto-runs read-only commands such as `cat` and `ls` in every permission mode, so the hook is the fence). The SDK runs in `dontAsk` mode with `blockReadsOutsideWorkingDirectories` as a second layer, and the agent gets no user or project Claude settings (`settingSources: []`) and no `DATABASE_URL`. Every SDK message is saved as a `run_event` (API key redacted) and announced on `NOTIFY` by id only, because `NOTIFY` payloads are capped at 8 KB.
5. **Report.** The agent calls `report_result` with the verdict payload below. The worker validates it with zod, stores artifacts and comments, records final tokens and cost, and sets the run state.
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

`acceptanceCriteria` is Plan B's checklist. On `success` it replaces the previous agent-written criteria; the owner's own criteria are never touched. Each milestone adds the fields its agents use to the `report_result` schema (`packages/shared/src/verdict.ts`): M2 has `verdict`, `summary`, `artifacts`, `acceptanceCriteria` and `questions`; M3 adds `touchPaths` (Plan B's predicted touch set), `comments` and `crossTicketRisks` (Nancy) and `criteriaResults` (Testy, by the criterion ids shown in the context). Each review replaces the reviewer's earlier comments (they are marked resolved), so unresolved comments are always the latest review's.

### Rules the orchestrator enforces

- **Cancellation**: moving a ticket away, "Pause all", or a budget breach aborts the run via an `AbortController`; commits already made stay on the branch. The ticket's next run waits until the aborted one has fully stopped, so two agents never share a worktree.
- **Crash recovery**: one worker per database (a Postgres advisory lock; a second worker exits at start). On worker start, any run left in `running` becomes `interrupted` and the ticket shows a Retry / Resume choice. A run whose result the worker cannot record (a git or database error after the agent stopped) is marked `failed` with that error at once, so it never holds a concurrency slot.
- **Resume**: a run that ends `awaiting_input` (`needs_input`) is finished, like `failed`: it stores the agent session ID and frees the ticket's one active run, so Rubber Duckworth can run on the Blocked ticket. When the user answers and clicks Resume, a new run of the same agent starts in the column the ticket came from, resuming that session with the answer appended instead of starting cold. The same Resume works after `failed`, `timed_out` and `budget_exceeded` (UC-13). (Decided 2026-11-03; built in M4.)
- **Post-run checks**: after every run in a worktree, the worker fails the run (ticket to Blocked, commits kept, nothing reverted) if the worktree left its ticket branch, any commit the run made reached the default branch (the owner committing to the default branch during a run is fine), commits that existed before the run were rewritten (amend, reset, rebase), the run changed any file under `.kanbot/`, or the run changed files outside the agent's `editScope` (for Testy McTestface: the project's test globs). Only what the run itself committed or left dirty counts; files an earlier run left behind are not its change.
- **Idempotency**: jobs carry the run ID; a run that is already terminal is never executed twice.

### Stall detection

Hard limits (turns, timeout, budget, bounce limit) guarantee every run ends; stall detection ends a spinning run early. The worker enforces these rules itself rather than trusting the agent to notice.

| Signal | Rule | Result |
| --- | --- | --- |
| Repetition | The same tool call with the same arguments 3 times with no file edit in between (a command failing with the same error 3 times is the same call; rerunning tests after an edit is not) | Run stops with `needs_input` and the repeated action as the reason (M3) |
| No progress | About 15 turns with no file changes and no new test results | Run stops with `needs_input` (M4) |
| Repeated feedback | Code Review or QA raises essentially the same issue (same file, line and message) on a second bounce | Ticket goes to Blocked instead of bouncing again (M6) |
| Recurring block | A ticket lands in Blocked a second time for the same reason | Duckworth flags it as recurring and suggests re-planning or splitting the ticket (M4) |

**Rubber Duckworth's own limits.** Duckworth only diagnoses: read-only access, no shell, around 10 turns and a $0.25 budget, one run per entry to Blocked. It can't resume or move a ticket; only the owner's answer and Resume do that. If its run fails, the worker posts a plain fallback summary (last error and last verdict) and the ticket stays in Blocked.

### Failure handling

Outside services fail routinely, so the worker sorts every error into transient (retried quietly) or permanent (surfaced immediately), and the board always shows what is degraded.

| Failure | Behavior |
| --- | --- |
| Anthropic rate limit (429) or overloaded / 5xx | The Agent SDK's built-in retry with backoff handles it; each retry is logged as a "waiting on API" line in the Live tab and turns the health indicator amber. Retries don't count against the run's turn limit. If the SDK gives up, the run becomes `interrupted`, the ticket stays put with Retry. |
| Anthropic unavailable for more than 10 minutes | Run becomes `interrupted` and a banner appears; runs resume automatically once a health probe (every minute, listing models: free) succeeds. Only a ticket's latest run restarts, and only while the ticket is still in that run's column with nothing active, so anything the owner did meanwhile wins. Runs stopped by Pause all restart the same way when agents resume. |
| Anthropic auth or billing error (invalid key, no credit) | The run fails and all agents pause, with the error as the pause reason in the banner (the notification comes with notifications); nothing retries until the owner resumes. |
| GitHub rate limit | Wait until the reset time GitHub reports; GitHub calls queue instead of failing runs. |
| GitHub push or PR creation fails | Retry 3 times, then move the ticket to Blocked with the error. PR creation checks for an existing PR first, so retries never open duplicates. |
| A command hangs (tests, install) | A per-command timeout (default 10 min) kills the process; the agent sees the timeout and decides what to do. (Built so far for the worker's own install only. An agent's command is bounded by the run's timeout until M4.) |
| Worker crashes mid-run | On restart the run becomes `interrupted`; pushes are safe to repeat because they target a known commit. |
| Database unavailable | The web app shows an error page; the worker stops claiming jobs until it reconnects. |
| Disk over 90% full | No new runs start and a banner appears. A nightly cleanup job prunes worktrees of finished tickets, package caches and run logs past retention, so this should be rare. |

`GET /api/health` reports database, worker, Anthropic and GitHub status; the board's top bar shows it as a single indicator. The worker counts as up while it holds a Postgres connection named `kanbot-worker` (`pg_stat_activity`), so no heartbeat table is needed. Anthropic is judged from the latest runs: an API retry in a running run is `degraded`, an API error on the last finished run is `down`. GitHub reports `unknown` until M5.

### Testing without real agents

The orchestrator is tested against a replay runtime, so automated tests are fast, repeatable and never spend tokens.

- `ReplayRuntime` implements the same `AgentRuntime` interface as the SDK adapter and is selected with `KANBOT_RUNTIME=replay`. It plays `fixtures/runs/<agent>/<scenario>.json`, where the scenario is a ticket label `replay:<name>` (else `default`), so an e2e test picks a script by labelling a ticket.
- **Scripted runs.** A test declares each agent's events and final verdict (e.g. Nancy returns `changes_requested` twice, then `success`) to exercise bounce limits, Blocked, budgets and cancellation. A scripted run can include a patch that the replay applies to the worktree, so the diff, CI and PR paths have real changes to work with.
- **Recorded runs.** With `KANBOT_RECORD=1`, a real run on a ticket labelled `replay:<scenario>` is saved as `fixtures/runs/<agent>/<scenario>.<n>.json` (the agent's nth run on that ticket) in the same format as hand-written scripts: events, report, usage and the run's commits as one patch, secrets redacted, the run's folder replaced by `<cwd>` and criterion ids by `$criterion1`… placeholders. Replay plays `<scenario>.<n>.json`, else `<scenario>.json`, else the agent's `default.json`, and applies a script's patch as a real commit.
- **Simulated failures.** Replays can inject API 429s, timeouts, crashes mid-run and malformed verdicts to test the failure handling above.
- Vitest and Playwright suites use only the replay runtime; CI never calls the real Anthropic API. A small manual smoke suite runs real agents against a sample repo before releases.

### Checking agent quality

Prompts, models and plugins decide how good the agents are, so any change to them is checked against a fixed set of tickets before it merges.

- **Golden tickets.** Four tickets in `fixtures/golden/` on the sample repo (`fixtures/sample-repo`, a zero-dependency Node + TypeScript todo app): a small feature, a bug fix (the bug is planted), a UI change, and one written so Code Review should request changes.
- **When it runs.** Before merging any change to an agent's prompt, model, plugins or limits, the golden tickets run end to end with real agents (`pnpm eval:agents`).
- **What it compares.** For each ticket: whether it reached the end of the build loop (QA passed, awaiting approval; PR Review once Ship exists in M5), bounce count, cost, run time and diff size, against `evals/baseline.json`. Results go to `evals/results/`, which is gitignored (run data stays out of the repo), and are summarized in the PR description. The eval runs in the `kanbot_test` database with an in-process worker loop, and approves each plan as soon as it's ready.
- **Pass bar.** If any golden ticket fails to finish, or total bounces or cost rise by more than 25%, the change needs the owner's explicit OK before merging.
- **Cost.** A few dollars per check, under the same budget caps as normal runs.

## 9. Overlapping tickets and merge conflicts

Kanbot avoids most collisions before code is written by tracking which files each ticket expects to touch, and handles the rest at merge time with a rebase, resolve and re-test loop.

### How overlap is detected

1. **Touch set.** Plan B's plan must list the files and folders it expects to change (paths or globs). These are stored on the ticket as `touch_paths`. After each Sir Codes-a-Lot run, the worker adds the files the branch actually changed.
2. **Related tickets.** Plan B receives the titles, plan summaries and touch sets of all open tickets, and its verdict must name related or dependent ones (`relatedTickets`, each `blocks` or `relates`). The user confirms the proposed links.
3. **Hotspots.** Each project names groups of files where concurrent changes almost always collide, such as the database schema or route definitions. Two tickets touching the same hotspot group overlap even if no individual file matches.
4. **Overlap check.** Before a ticket enters In Progress, the move compares its touch set and hotspot groups with every ticket between In Progress and PR Review. On overlap the move is refused (409 `overlap`, e.g. "Overlaps tickets in flight: KB-12 (3 files, hotspot database)") and the board asks whether to start anyway. A ticket with no touch set yet overlaps nothing. Showing overlaps on the cards themselves comes with ticket links (M4).
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

Hotspots are declared per project in `.kanbot/project.yml` (checked into the repo) or in Settings, as named groups of globs:

Until Settings (M4) and onboarding (M5) exist, `.kanbot/project.yml` is the only source, and it also holds the project's `commands` (install, build, test, lint) and `testGlobs`. Kanbot reads it from the default branch (`git show <default>:.kanbot/project.yml`), never from a worktree, so an agent can't widen its own allowlist; agents may not change it at all (post-run check).

```yaml
hotspots:
  - name: database
    paths: ["db/schema.ts", "db/migrations/**"]
  - name: api-routes
    paths: ["apps/web/app/api/**/route.ts"]
  - name: env
    paths: [".env.example", "packages/shared/src/env.ts"]
```

- Globs are matched against both predicted and actual touch sets.
- Hotspot overlap always serializes, even when `overlapPolicy` is `parallel`, unless the user clicks "Start anyway".
- On a project's first plan, Plan B suggests hotspots from the files changed most often in recent git history and from shared config, schema and route files. The user confirms or edits them.
- Tickets touching different hotspot groups do not overlap through hotspots.

### Cross-ticket review by Nitpick Nancy

Nancy catches the overlap that file lists miss: one ticket changing a contract that another in-flight ticket relies on.

- **Extra context.** For every other ticket between In Progress and PR Review: its title, plan summary and branch diff, capped at 1,500 lines in total. Past the cap she gets diff stats and plan summaries only.
- **What she checks.** Changes to exported function signatures and types, API request and response shapes, database columns, environment variables and event names that another in-flight ticket uses or also changes.
- **What she reports.** Her verdict adds `crossTicketRisks`, each with the other ticket, the kind of contract, a description and a severity.
- **Blocking risk.** Treated as `changes_requested` (the worker downgrades a `success` that carries one). The note is posted on both tickets; proposing a `blocks` link for the human to confirm arrives with ticket links (M4).
- **Warning.** A comment on both tickets; no bounce.

### Keeping in-flight branches current

- Before every agent run, the worker fetches and, if the ticket branch is behind main, rebases it first. Agents never run git rebase themselves.
- When a PR merges into main, the worker finds open tickets whose touch sets overlap the merged files and queues a rebase for each.
- A clean rebase is pushed with `--force-with-lease`. This is the only force-push in the system, done by the worker and only on `kanbot/*` branches. CI then reruns on GitHub.
- A rebase with conflicts starts **Marge Conflict**.

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
- **Events.** Webhooks for `pull_request`, `pull_request_review`, `pull_request_review_comment`, `check_suite` and `push`, sent to `/api/webhooks/github` and verified by signature. The DigitalOcean server has a public HTTPS URL, so GitHub delivers webhooks directly; polling every 60 s stays as a fallback for missed deliveries.

### Two-click setup

Kanbot creates its GitHub App from a manifest, so the owner never copies keys or configures webhooks.

1. During onboarding the owner clicks **Connect GitHub**. The browser opens github.com showing an app pre-filled by Kanbot: name, the permissions above, a webhook URL pointing at the server, and a callback URL for sign-in. The owner clicks **Create**.
2. GitHub asks where to install it. The owner picks repos (or all repositories) and clicks **Install**.

GitHub redirects back to Kanbot, which exchanges the one-time code for the app's ID, private key and webhook secret and stores them encrypted in the database, with the encryption key in the server's `.env`. The same app provides Sign in with GitHub for Kanbot's own login, restricted to the owner's account. Adding repos later is one link from Settings.

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
- CI failing on a PR bounces the ticket to In Progress with the failing job's log excerpt attached.

### The human review loop

Captain Ship-It opens the PR with a description linking the ticket, plan, review and test report. The ticket waits in Ship until CI is green, then moves to **PR Review**, a human gate. There the human can:

| Action | Where | Result |
| --- | --- | --- |
| Approve and merge | GitHub, or the Merge button in Kanbot (enabled only once a human approval exists) | Ticket to Done; Archie runs. Kanbot never merges without a human click. |
| Request changes | GitHub review, or comments in Kanbot's Diff tab | Comments imported; ticket bounces to In Progress; Sir Codes-a-Lot pushes fixes to the same PR, which goes back through Code Review and QA. A "small fix" checkbox skips straight back to PR Review. |
| Push their own commits | Locally or on GitHub | Kanbot records the new head; the next agent run starts from it, and human commits are never rewritten. |
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
4. **Detect commands.** Kanbot reads the package manager, lockfile and scripts and proposes install, build, test and lint commands plus test-file globs and QA settings (app start command, ready URL, required services); the owner confirms or edits them.
5. **Baseline run.** Kanbot runs install, build and tests once on the default branch. Failures are shown so the owner can fix them or accept them as a known baseline; agents are never blamed for failures that were already there.
6. **CI.** If no workflow exists, Kanbot opens a PR adding a starter GitHub Actions workflow built from the confirmed commands.
7. **Branch protection.** Kanbot checks the default branch and offers to apply the rules above.
8. **Hotspots.** Plan B suggests hotspot groups (section 9); the owner confirms them.
9. **CLAUDE.md.** If the repo has none, Kanbot drafts one (layout, commands, conventions), plus a `.claude/claude-security-guidance.md` threat-model note for the Security Guidance plugin, and opens them as a PR.
10. **Ready.** The board appears with the default columns; agents are enabled once branch protection is in place or explicitly overridden.

## 11. Data model

Ten tables plus a single-row `settings` table cover v1; all IDs are UUIDv7, all timestamps `timestamptz`, and JSON payloads are `jsonb` validated by shared zod schemas.

| Table | Key fields | Notes |
| --- | --- | --- |
| `projects` | id, key\_prefix, name, repo\_path, default\_branch, github\_owner, github\_repo, commands (jsonb: install, build, test, lint, QA start command and ready URL), test\_globs, hotspots (jsonb: name and globs per group), baseline (jsonb: tests already failing at onboarding), settings (jsonb: budgets, concurrency, auto-moves), created\_at | `key_prefix` unique; next ticket number tracked in `ticket_seq`. Until M4, commands, test globs and hotspots come from the repo's `.kanbot/project.yml` (section 9) instead of these columns. |
| `columns` | id, project\_id, slug, name, position, agent\_slug (nullable), wip\_limit, auto\_advance (bool) | Seeded with the default workflow per project. |
| `tickets` | id, project\_id, number, title, description\_md, type, priority, labels\[\], column\_id, position, parent\_id, branch\_name, worktree\_path, bounce\_count, status\_flag (`none`, `running`, `needs_input`, `plan_ready`, `awaiting_approval`, `waiting_on_ticket`, `pr_open`, `failed`), touch\_paths\[\], pr\_number, pr\_url, head\_sha, ci\_state, review\_state, created\_at, updated\_at | `(project_id, number)` unique; `position` is a fractional index for ordering in a column. |
| `acceptance_criteria` | id, ticket\_id, position, text, status (`open`, `pass`, `fail`), source (`user`, `agent`) | QA updates status. |
| `ticket_links` | from\_ticket\_id, to\_ticket\_id, kind (`blocks`, `relates`) | Epics use `tickets.parent_id`, not this table. |
| `runs` | id, ticket\_id, agent\_slug, agent\_config\_hash, column\_slug, state, verdict, summary, request\_md, session\_id, input\_tokens, output\_tokens, cost\_usd, budget\_usd, created\_at, started\_at, ended\_at, error | One active run per ticket enforced with a partial unique index on non-terminal states (`queued`, `running`; `awaiting_input` leaves it in M4, see §8 Resume). `budget_usd` is set when the run is claimed: the agent's budget, capped by what is left of the day; while the run goes, it counts toward today's spend. Also the job queue (§7). Token counts include cache reads and writes. `request_md` is the owner's Revise plan text the run answers (UC-3); null otherwise. |
| `run_events` | id, run\_id, seq, type (`assistant`, `tool_call`, `tool_result`, `stdout`, `system`), payload (jsonb), created\_at | Append-only; `(run_id, seq)` unique; pruned after 90 days except the last run per ticket. |
| `artifacts` | id, ticket\_id, run\_id, kind (`plan`, `research`, `review`, `test_report`, `blocker`, `retro`, `diff_snapshot`), title, version, content\_md, data (jsonb), created\_at | New versions never overwrite old ones. |
| `comments` | id, ticket\_id, author\_kind (`user`, `agent`), agent\_slug, body\_md, file, line, resolved, created\_at | Review line comments use `file` and `line`. |
| `activity` | id, ticket\_id, actor\_kind, actor, action (`created`, `moved`, `run_started`, `run_finished`, `commented`, `edited`), data (jsonb), created\_at | Drives the ticket timeline and the audit trail. Criteria changes are `edited` with `fields: ["criteria"]`. |

Global settings (daily budget, global concurrency, serious mode, pause-all flag, encrypted GitHub App credentials) live in a single-row `settings` table (id 1; a missing row means the defaults). M4 adds `paused`, `paused_reason` (set when Kanbot paused itself) and `daily_budget_usd`; each other field arrives with its first user. Until then the concurrency limits are constants in the worker. `projects.repo_path` exists from M2: an optional absolute path to a local checkout that Plan B reads; onboarding fills it with the clone path from M5.

## 12. API and real-time events

The web app exposes a JSON REST API under `/api` (used by the UI and a future CLI) plus one SSE stream; all bodies are validated with the shared zod schemas and errors return `{error: {code, message}}`.

### REST endpoints

| Method | Path | Purpose | Milestone |
| --- | --- | --- | --- |
| GET / POST | `/api/projects` | List or create projects. | Built |
| GET / PATCH | `/api/projects/:id` | Read or update project settings. | M4 |
| GET | `/api/projects/:id/board` | Columns with ordered ticket cards (one call renders the board). | Built |
| POST | `/api/projects/:id/tickets` | Create a ticket. | Built |
| GET / PATCH / DELETE | `/api/tickets/:id` | Read (with criteria, latest artifacts, active run), edit, delete. | Built |
| POST | `/api/tickets/:id/move` | Body `{toColumnId, position, confirmCancel?, startAnyway?, keepPlan?, requestMd?}`. Validates the transition, cancels any active run if confirmed, enqueues the column's agent. Returns 409 `run_active` if a run is active and `confirmCancel` is not set, and 409 `overlap` when entering In Progress overlaps an in-flight ticket and `startAnyway` is not set (section 9). A move to Planning resets the bounce count; if the ticket has a plan it returns 409 `has_plan` unless `keepPlan` (no run, flag Plan ready) or `requestMd` (Plan B revises with it) is set. | Built |
| GET / POST | `/api/tickets/:id/comments` | List or add comments. | Built |
| POST | `/api/tickets/:id/criteria` | Body `{text}`. Add an acceptance criterion. | Built |
| PATCH / DELETE | `/api/criteria/:id` | Body `{text?, status?}`. Edit or remove a criterion. | Built |
| GET | `/api/tickets/:id/activity` | Timeline. | Built |
| GET | `/api/tickets/:id/diff` | `{branch, base, diff, truncated, comments}`: the unified diff of the ticket branch vs the default branch (`base...branch`, capped at 1 MB) and the review's line comments. | Built |
| GET | `/api/tickets/:id/runs` | Run history. | Built |
| GET | `/api/runs/:id/events?after=seq` | Paged run log (for catching up before streaming). | Built |
| POST | `/api/runs/:id/cancel` | Cancel a run. | Built |
| POST | `/api/tickets/:id/approve-plan` | Moves the ticket to the bottom of Ready, the same as dropping it there. 409 unless the ticket is in Planning, has a plan, and has no active run. | Built |
| POST | `/api/tickets/:id/revise-plan` | Body `{requestMd}`. Starts Plan B with the request (UC-3). 409 unless the ticket is in Planning, has a plan, and has no active run. | Built |
| POST | `/api/runs/:id/retry` | Start a fresh run of the same agent. If the failure moved the ticket (e.g. to Blocked), it goes back to the run's column first. | Built |
| GET | `/api/health` | Database, worker, Anthropic and GitHub status (section 8). | Built |
| GET | `/api/agents/:slug/avatar` | The agent's avatar SVG from `agents/`. | Built |
| POST | `/api/runs/:id/resume` | Body `{answer}`. Resume a `needs_input` run with the user's answer. | M4 |
| GET / PUT | `/api/agents`, `/api/agents/:slug` | List agents; read or save an agent definition file. | M6 |
| GET | `/api/costs?groupBy=day\|agent\|ticket&from&to` | Cost reports. | M6 |
| GET / PATCH | `/api/settings` | Read Pause all, the pause reason, the daily cap and today's spend; body `{paused?, dailyBudgetUsd?}` pauses or resumes all agents and sets the cap. Resuming clears the pause reason. | M4 |

GitHub endpoints (all M5): `POST /api/webhooks/github` receives signature-verified webhooks; `POST /api/tickets/:id/merge` merges only when GitHub reports a human approval and green checks. "Start anyway" is the move's `startAnyway` flag rather than its own endpoint. `GET /api/github/setup` starts the two-click GitHub App setup and `GET /api/github/callback` completes it; `/api/auth/*` handles Sign in with GitHub.

### SSE stream

`GET /api/events?projectId=...` streams typed events, each with an `id` so the browser can reconnect with `Last-Event-ID`. Events are sent unnamed, and the type is the `type` field of the JSON data, so one `onmessage` handler sees them all:

- `ticket.created` — `{ticketId}`
- `ticket.moved` — `{ticketId, fromColumnId, toColumnId, position, actor}`
- `ticket.updated` — `{ticketId, fields}` (`fields` names the changed fields; `criteria` for checklist changes)
- `ticket.deleted` — `{ticketId}`
- `run.started` / `run.finished` — `{runId, ticketId, agentSlug, state, verdict?, costUsd?}`
- `run.event` — `{runId, ticketId, seq, eventType}`: ids only, because `NOTIFY` payloads are capped at 8 KB; the Live tab fetches the new lines from `GET /api/runs/:id/events?after=seq`. Sent to every client of the project (no `&runId=` filter; the board ignores them).
- `comment.created` — `{ticketId, commentId}`; `artifact.created` — `{ticketId, artifactId}`
- `notification` — `{kind, ticketId, message}` (M4)
- `settings.updated` — `{paused}`, sent to every project's stream; the worker stops its runs when `paused` (M4)

The app is publicly reachable on the DigitalOcean server, so every route except the GitHub webhook requires login: Sign in with GitHub through the Kanbot GitHub App, restricted to the owner's account, with a secure, HTTP-only session cookie. The webhook endpoint is authenticated by its HMAC signature instead.

## 13. UI requirements

Five screens make up v1, and the board is home: at a glance the user must see which agent is working on what, and which tickets need them.

### Board (home)

- One column per workflow stage; header shows the column name, the owning agent's avatar, the card count and WIP limit (`3 / 4`).
- Cards show key, title, type icon, priority, and a status pill: agent avatar with spinner (running), amber "Needs you" (needs input or awaiting approval), red "Failed", or a bounce counter (`↩ 2`).
- Drag and drop with keyboard support; dropping into an agent column shows a toast like "Plan B is on it." Dropping a running ticket opens the cancel confirmation.
- Top bar: project switcher, quick-add input, "Needs me" filter count, today's spend vs daily cap, a health indicator (database, queue, Anthropic, GitHub), and the Pause all switch.

### Ticket drawer

Opens as a right-side panel over the board with:

- Header: key, editable title, type, priority, column, branch name, PR link.
- Description (markdown editor) and acceptance-criteria checklist with pass/fail markers from QA.
- Tabs: **Activity** (timeline), **Live** (streaming run log with collapsible tool calls and terminal output, elapsed time, running cost, Cancel button), **Artifacts** (plan versions, research, reviews, test reports, retro rendered as markdown), **Diff** (unified diff with Nancy's line comments inline; side-by-side is M6 polish), **Comments** (agent comments show the agent's avatar and `file:line`).
- When the ticket is Blocked: Duckworth's questions shown at the top with an answer box and a Resume button.

### Agents page

Roster cards (avatar, name, tagline, column, model, runs this week, success rate, average cost) and an editor for each agent's frontmatter and prompt with validation errors shown inline.

### Costs page

Spend by day (bar chart), by agent, and by ticket, with token counts; budget settings editable here.

### Settings

Projects (repo, commands, test globs, QA settings, hotspots), workflow columns (Later), concurrency, budgets, serious mode, notification and webhook settings. Adding a project runs the onboarding flow (section 10) as a guided wizard.

### General

- Dark and light themes; responsive down to tablet width (phone is view-only in v1; approving from a phone is planned for M6).
- Optimistic UI for moves, rolled back if the server rejects the transition.

## 14. Safety, guardrails and cost controls

Agents run real commands on the server, so every agent is boxed in by its worktree, its tool allowlist, a budget, and a hard rule that nothing reaches the default branch without a human merge.

### Code and repo safety

- Agents run only inside the ticket's worktree; the main checkout is never their working directory. The one exception is a read-only agent that runs before a worktree exists (Plan B): its `cwd` is the project checkout, and its tools are read-only (`Read`, `Grep`, `Glob`), enforced by the permission hook.
- Worktrees live beside the checkout, at `<repo>.kanbot-worktrees/<KEY-n>`, on branch `kanbot/<KEY-n>-<slug>`. The worker creates them from the default branch on a ticket's first In Progress, Code Review or QA run (or reattaches the existing branch) and refuses any branch outside `kanbot/` or path outside that folder. Deleting a ticket removes its worktree and keeps its branch.
- The permission hook fences every agent to its `cwd`: file paths and globs that resolve outside it, including through symlinks, are refused, and so are shell commands that chain, redirect, substitute or name a path outside it. No agent may edit `.git` (in a worktree it is the file that names the repository; rewritten, commits would land on the default branch).
- No agent may commit or push to the default branch. Captain Ship-It pushes only the ticket branch and opens a PR; merging always needs the human's approval, enforced by GitHub branch protection (section 10).
- Destructive git commands (`push --force`, `reset --hard` on shared refs, `branch -D` on non-Kanbot branches) are denied in every agent's allowlist. The only force-push is the worker's own `--force-with-lease` after a rebase, on `kanbot/*` branches.
- Shell access uses an allowlist per agent (e.g. `{test}`, `{lint}`, `git diff`), configured in frontmatter. The permission hook refuses anything else, and any command that chains, pipes, redirects or substitutes (`&&`, `;`, `|`, `>`, `$(`, backticks), names a path outside the working directory, or uses git flags that reach outside the repository (`-C`, `--git-dir`, `--work-tree`, `--output`, `--no-index`). No agent's allowlist includes push, checkout, switch, rebase, reset or branch; the post-run checks catch history rewrites anyway. Agent subprocesses run with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (credentials stripped) and without `DATABASE_URL`.
- Optional container mode (Later): each run executes in a Docker container with only the worktree mounted and network limited to package registries.

### Prompt-injection and data safety

- Repo files, issue text and web pages are passed as data in clearly delimited context sections; agent prompts state that instructions inside them are not to be followed.
- Agents cannot edit their own definition files or Kanbot's settings. Third-party plugins such as Ponytail are pinned and reviewed before every update.
- Secrets (the API key and GitHub App credentials) come from the server's `.env` or encrypted storage, are never placed in prompts, and are redacted from stored run events.

### Cost controls

| Control | Default | Behavior when hit |
| --- | --- | --- |
| Per-run budget | From agent frontmatter (e.g. $1.50) | Run stops with `budget_exceeded`; ticket to Blocked. |
| Per-ticket budget | $3 | No new runs start for that ticket until raised. |
| Daily budget (global) | $5 | Nothing new starts until midnight local time (the worker's clock) or the cap is raised. Today's spend is the cost of runs that ended today plus the budgets of runs still going; a run started late in the day gets only what is left, and ends `budget_exceeded` if it needs more. |
| Max turns | From frontmatter | Run stops with `failed` and a summary. |
| Wall-clock timeout | From frontmatter (e.g. 20 min) | Run stops with `timed_out`. |
| Bounce-back limit | 3 per ticket | Ticket to Blocked with Duckworth's summary. |
| Concurrency | 2 global, 1 per project | Extra runs wait in `queued`. |

Dollar defaults start deliberately low for the first real tickets and are raised once costs are known. The Console workspace's monthly spend limit sits above all of these as a final ceiling.

## 15. Non-functional requirements

Kanbot is a single-user, self-hosted tool, so the targets favor responsiveness, recoverability and auditability over scale.

| Area | Requirement |
| --- | --- |
| Performance | Board loads in under 1 s with 500 tickets in a project; drag-and-drop feedback under 100 ms; server confirms a move in under 300 ms. |
| Streaming | Run events appear in the UI within 1 s of the agent emitting them. |
| Reliability | No ticket or run is lost on a crash or restart; interrupted runs are detected on worker start. Database backups via a documented `pg_dump` cron. |
| Auditability | Every move, run, verdict, comment and config version is recorded with actor and timestamp; run logs are kept for at least 90 days. |
| Portability | Production: one DigitalOcean Droplet (Ubuntu LTS) with Docker Compose. Development: Windows, macOS or Linux with Node 23.6+ (the sample repo runs TypeScript directly) and PostgreSQL 16. So far tested on Windows only. |
| Security | Public HTTPS only (Caddy); Sign in with GitHub limited to the owner; firewall restricts SSH; secrets only from env and never passed to agent shells. |
| Accessibility | Board operable by keyboard (dnd-kit keyboard sensor); color is never the only status signal (pills also carry text or icons). |
| Code quality | TypeScript strict mode, ESLint, Prettier; unit tests for the transition engine, verdict handling and budget logic; Playwright test for the happy-path board flow; CI on GitHub Actions. |
| Extensibility | Adding an agent = adding one markdown file and assigning it to a column; no code change. |

## 16. MVP scope and milestones

Build in five milestones, each ending in something usable, so agents are added onto a board that already works rather than all at once.

1. **M1 — Board without agents.** *(Done; `docs/m1-report.md`.)* Monorepo scaffold, Docker Compose, Postgres + Drizzle schema and migrations, project creation, tickets with criteria and comments, drag-and-drop board with the default columns, activity log, SSE for moves. *Done when:* tickets can be created and moved and the board updates live in two browser tabs.
2. **M2 — Orchestrator and Plan B.** *(Done; `docs/m2-report.md`.)* Runs-table queue, worker process, `AgentRuntime` adapter on the Claude Agent SDK, agent file loader, context assembly, `report_result` tool, run events streamed to the Live tab, cancel and retry, per-run budget, the replay runtime for tests, API retry with backoff, and the health indicator. *Done when:* moving a ticket to Planning produces a plan artifact and a "Plan ready" flag.
3. **M3 — Build loop.** *(Done; `docs/m3-report.md`.)* Worktree manager, Sir Codes-a-Lot, Nitpick Nancy, Testy McTestface, transition table with auto-moves and bounce-backs, bounce limit, diff viewer, post-run path checks, touch sets, hotspot groups, the serialize overlap check, Nancy's cross-ticket review, stall detection (repetition), the plugin loader with Ponytail, the sample repo, recorded runs and the golden-ticket quality check. *Done when:* a small feature goes Ready → In Progress → Review → QA on its own, including at least one bounce-back.
4. **M4 — Unblock (local).** Blocked column with Rubber Duckworth, resume with answer, Archie's retro and worktree cleanup, in-app notifications, cost tracking and daily cap, Pause all, project Settings in the database, ticket links. Still local: no GitHub, no deployment. Also owns its rows in "Still to build" below. *Done when:* a `needs_input` run can be answered and resumed, Pause all and the daily cap stop new runs, and a ticket moved to Done gets Archie's retro and loses its worktree.
5. **M5 — Ship and deploy.** DigitalOcean deployment (section 7) with Sign in with GitHub and the nightly disk cleanup, the onboarding walkthrough (section 10) with GitHub App connection and branch-protection check, Captain Ship-It with PR creation, CI status tracking, the PR Review gate with review-comment bounce-backs, merge detection, auto-rebase when main moves. Also owns its rows in "Still to build" below. *Done when:* a ticket goes from Backlog to a human-approved, merged PR.
6. **M6 — Polish (Later items).** Dr. Rabbit Hole and spikes, epics with child tickets, auto-pull from Ready, Marge Conflict, stacked branches, Agents and Costs pages, editable workflow columns, webhooks, container mode, approving from a phone (plans, ship, Blocked answers, pause all), and the kanbot CLI.

MVP = M1 through M5. M1 to M4 run locally; M5 moves Kanbot to the DigitalOcean server, because webhooks and the GitHub App need a public URL. Shipping was split out of M4 on 2026-11-03 so everything local is finished before any infrastructure is needed.

### Still to build

Everything the spec describes that isn't built yet, with the milestone that builds it. Whoever builds that milestone owns the row. Anything deferred, cut or moved goes here in the same change. Finished rows are deleted; what each milestone built is in its report (`docs/m<n>-report.md`).

**M4**

| Item | Spec | Notes |
| --- | --- | --- |
| Project settings in the database (`commands`, `test_globs`, `hotspots`, `settings`) and a Settings page; per-project bounce limit and concurrency | §11, FR-2, FR-23, §14 | `.kanbot/project.yml` on the default branch until then; `BOUNCE_LIMIT` and `LIMITS` are constants. Command detection comes with onboarding (M5); in M4 the owner fills them in, seeded from `project.yml`. |
| Ticket links: `ticket_links`, "blocked by", Plan B's `relatedTickets`, Nancy's proposed `blocks` links, overlap shown on cards | §9, FR-14 | Needs a confirm-links UI. The overlap check uses touch sets and hotspots only. |
| Agent files for Rubber Duckworth and Archie | §4, §17 | Until a file ships, its column is a gate. Locally a ticket reaches Done by a manual move with no PR; Archie runs on it as on an unmerged ticket (§3 Done row, minus closing the PR). |
| Resume with answer: `awaiting_input` out of the active states and the one-active-run index; `POST /api/runs/:id/resume` starts a new run in the blocked run's column with its session and the answer | §8 Resume, §11, UC-7, UC-13 | Decided 2026-11-03 (§8 Resume). Until then a `needs_input` run stays active and Duckworth can't run beside it. |
| Stall detection: no progress, recurring block | §8 | Max turns, budget and the bounce limit already bound every run; the recurring block is Duckworth's. Marked with a `shortcut:` comment. |
| Resuming the agent's session on a bounce-back | FR-35 | Bounced runs start cold with the review or test report in context. `resume: sessionId` is verified in the SDK; sessions are files on the worker's machine. |
| Only the agent's own plugins in its session | §8 | Skills are already limited to our plugins' skills. Claude Code's bundled plugins (`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`) still load with `settingSources: []`; find the SDK switch for them. |
| Install when the lockfile changes (not only when the worktree is created) | §8 step 2 | Agents can run `{install}` themselves. |
| Per-command timeout for agents' shell commands | §8 failure handling | Found in the 2026-11-03 docs cleanup: only the worker's own install has the 10-minute timeout; an agent's command is bounded by the run's timeout. |
| Worktree removal when a ticket reaches Done | FR-49 | Archie. Deleting a ticket already removes its worktree. |
| `blockWritesOutsideWorkingDirectories` | §7, §14 | Needs Claude Code 2.1.314; the pinned SDK bundles 2.1.304. Writes are fenced by the permission hook and the post-run checks meanwhile. |
| The top bar's agent notice clears when the run ends | §13 | It stays up after the run ends, until the next move. Cosmetic. Marked with a `shortcut:` comment. |
| A golden ticket that reliably makes Nancy request changes, so the eval covers a real bounce | §8 | With real agents, `review.json`'s bad hint was ignored by Sir Codes-a-Lot, so Nancy approved. Bounces are covered by replay tests; real bounces so far depended on run order. Rewrite the ticket and re-save the baseline. |

**M5**

| Item | Spec | Notes |
| --- | --- | --- |
| Compose `web`, `worker`, `caddy` services and Dockerfiles; DigitalOcean deployment and nightly disk cleanup | §7 | Compose has only `db`, bound to 127.0.0.1. |
| Sign in with GitHub; auth on every route | §12 | No auth yet. The dev server binds to 127.0.0.1, and `apps/web/proxy.ts` refuses any Host other than localhost (DNS rebinding) and cross-origin writes (CSRF). |
| GitHub App two-click setup, onboarding walkthrough with command detection and branch-protection check | §10, FR-3, FR-45 | |
| `projects`: github\_owner, github\_repo, baseline; clone and default-branch validation | FR-1, FR-3 | Need the GitHub App and onboarding. Projects are name, key prefix, default branch and an optional local `repo_path`. |
| `tickets`: pr\_number, pr\_url, head\_sha, ci\_state, review\_state | §11 | |
| Agent file for Captain Ship-It; PR creation, CI status, PR Review gate, merge detection, webhooks with polling fallback | §4, FR-43, FR-44, FR-46, FR-47, FR-48 | Ship stays a gate until then. |
| Ship/Done manual-move confirmations | §3, FR-24 | They guard opening and closing PRs, which arrive with Ship-It. |
| Fetch and rebase onto the default branch before each run; auto-rebase when main moves | §9, FR-51 | Locally nothing merges into main yet. |
| Commit trailers `Kanbot-Agent` / `Kanbot-Ticket` and the bot identity | FR-42 | With the GitHub App. Agent commits use the host's git identity until then. |
| SDK `sandbox` | §7, §14 | Linux/macOS only (dev is Windows; the Droplet is Linux). |
| GitHub status in `/api/health`; "PR ready for review" notification | §8, FR-60 | Health reports GitHub `unknown` until then. |
| SSE `Last-Event-ID` replay | §12 | Only if needed: the board refetches on reconnect and the Live tab pages `/api/runs/:id/events?after=seq`. Revisit when running over real networks. Marked with a `shortcut:` comment. |

**M6**

| Item | Spec | Notes |
| --- | --- | --- |
| Agent files for Dr. Rabbit Hole and Marge Conflict | §4, §9 | Until Marge ships, every conflicting rebase goes to Blocked. |
| Epics: `tickets.parent_id` and the verdict's `proposedTickets` | §11, UC-11 | |
| Agents and Costs pages | §13 | |
| Agent config hash on runs | FR-37 | With the Agents page. |
| Side-by-side diff view | §13 | The Diff tab is unified. |
| `columns.wip_limit`, `auto_advance`; WIP display and enforcement | FR-20, FR-22 | The only approval gate so far (QA → Ship) stays a gate; the concurrency limits already cap parallel runs. WIP limits matter most with auto-pull (M6). Moved from M4 on 2026-11-03. |
| Running cost while a run works | UC-8, §13 | The SDK reports cost only when a run ends (per-turn messages carry tokens, not dollars), so a live figure needs Kanbot's own price table. The drawer shows elapsed time live and cost at the end; today's spend counts a running run's budget. Moved from M4 on 2026-11-03. Marked with a `shortcut:` comment. |
| Playwright-based QA (browser exploration, Playwright MCP, per-ticket `PORT`, headless Chromium in the worker) | §4 "How QA runs" | Testy runs the suite and writes tests in the project's framework; the browser steps arrive with the Playwright plugin. Moved from M4 on 2026-11-03: each plugin needs its own eval spend. |
| TypeScript LSP, Context7, Security Guidance and Playwright plugins | §8 | Each adds context to every turn, so each is added once the golden-ticket eval can compare it on and off. Moved from M4 on 2026-11-03. |
| Stall detection: repeated feedback (same issue raised on a second bounce) | §8 | Needs fuzzy matching; the bounce limit already stops the loop. Moved from M4 on 2026-11-03. |
| Dark theme | §13 | shadcn dark tokens exist in `globals.css` but nothing switches to them yet. Moved from M4 on 2026-11-03. |

Known shortcuts are also marked in code with `shortcut:` comments (list them with `/ponytail-debt` or `git grep -n "shortcut:"`).

## 17. Open questions and notes for Claude Code

Nearly everything is decided; Claude Code builds to the Decided list below unless the owner changes it.

### Decided

- **Language:** TypeScript end to end (section 7). No Python; no Rust in v1.
- **Hosting:** one DigitalOcean Droplet with Docker Compose and Caddy (section 7).
- **Agent authentication:** a Claude Console API key, pay per token. Kanbot gets its own Console workspace with a monthly spend limit as a hard ceiling, prepaid credits and auto-reload off. If the owner later moves to a plan with monthly API credits, linking the same Console organization covers this key with no change to Kanbot.
- **Budget defaults:** start low at $3 per ticket and $5 per day, plus the per-agent run budgets in each agent file; raise them once real ticket costs are known.
- **Container isolation:** stays Later. Kanbot is single-user and works only on the owner's own repos with dependencies the owner chose; the MVP relies on the non-root worker, scrubbed agent environments, the firewall and login. Revisit before pointing Kanbot at repos with unfamiliar dependencies or opening it to other users.
- **GitHub identity:** a GitHub App created through the two-click setup (section 10). The same app provides Sign in with GitHub.
- **Approval gates:** only plan, ship and merge wait for the owner; manual moves behave as in section 3.
- **Models:** per-agent defaults in section 4, tuned once cost data comes in.
- **Overlap policy:** serialize by default; hotspot overlap always serializes (section 9).
- **QA:** Playwright for UI criteria and exploratory checks (section 4).
- **Plugins:** Ponytail, TypeScript LSP, Context7, Security Guidance and Playwright, pinned and bundled (section 8).
- **Phone approvals:** planned for M6, not the MVP.

### Still open

- [ ] **Name.** Keep "Kanbot" or pick another.

### Instructions for Claude Code

- Work milestone by milestone (section 16); stop at the end of each for review.
- Before writing agent-runtime code, check the current Claude Agent SDK package name, API, plugin loading and permission-hook mechanism in its official docs rather than relying on memory.
- Keep the transition table as data in `packages/shared` and cover it with unit tests using the replay runtime, so CI never calls the real API; it is the heart of the system.
- Keep the root `CLAUDE.md` (layout, commands, conventions) current.
- Keep this document in the repo as `docs/requirements.md` and update it in the same PR whenever a decision or behavior changes.
- Do not introduce Python in any part of the project, including scripts and tooling.
- Ship each agent's file in `agents/`, with a placeholder SVG avatar, in the milestone that wires that agent up (see "Still to build" in section 16). Draft each system prompt carefully and flag it for the owner's review before its milestone closes; prompt quality decides agent quality.
- Keep a `.env.example` listing every variable; never commit secrets, and never use real credentials in tests.
- Create a small sample repo (a tiny web app with tests) for the real-agent smoke suite and for demos.
