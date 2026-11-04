# M3 report: build loop

Status: **done, awaiting review.** Built 2026-11-03. Nothing is committed yet.

M3 in the spec (`requirements.md` §16): worktree manager, Sir Codes-a-Lot, Nitpick Nancy, Testy McTestface, transition table with auto-moves and bounce-backs, bounce limit, diff viewer, post-run path checks, touch sets, hotspot groups, the serialize overlap check, Nancy's cross-ticket review, stall detection, plugins, and the golden-ticket quality check. M3 also owned its rows in "Deferred from M1" and "Deferred from M2".
**Done when:** a small feature goes Ready → In Progress → Review → QA on its own, including at least one bounce-back. That is covered without API calls by a worker test and a Playwright test on a real git repo (replay runtime), and was run once with real agents (smoke test below).

Before M3 work, three M2 leftovers were fixed: Plan B's Read/Grep/Glob calls weren't fenced to its repo folder, plan titles were inconsistent, and the fence had no deferred-list entry.

## What you can do

1. Create a project with a **local repo path** whose default branch has a `.kanbot/project.yml` (commands, test globs, hotspots; see `fixtures/sample-repo/.kanbot/project.yml`).
2. Plan a ticket as in M2, drag it to **Ready**, then to **In Progress**. Kanbot creates a worktree beside your checkout (`<repo>.kanbot-worktrees/<KEY-n>`) on branch `kanbot/<KEY-n>-<slug>`, and Sir Codes-a-Lot implements the plan there, committing as he goes.
3. On success the ticket moves to **Code Review** and Nitpick Nancy reviews the branch. If she requests changes, the ticket bounces back to In Progress with her line comments (the card shows `↩ 1`), and Sir Codes-a-Lot runs again with them. When she approves, it moves to **QA / Testing**.
4. Testy McTestface runs the tests, writes one or more per acceptance criterion (test files only), and marks each criterion pass or fail. A pass leaves the card in QA flagged **Approve · needs you**; dragging to Ship is the approval (Ship-It arrives in M4). A failure bounces it to In Progress with the test report.
5. After 3 bounces the next one sends the ticket to **Blocked** ("Bounce limit (3) reached" in the timeline). Dragging back to Planning resets the count.
6. The drawer header shows the branch and bounce count. The new **Diff** tab shows the branch against the default branch with Nancy's comments under their lines, and comments show the agent's avatar and `file:line`.
7. Dragging a planned ticket to In Progress while another in-flight ticket touches the same files or hotspot asks "…overlaps tickets in flight: KB-12 (2 files). Start anyway?"
8. Deleting a ticket removes its worktree (the branch stays).

## How to run it

```
docker compose up -d db
pnpm install
pnpm db:migrate              # adds migration 0003_build_loop
pnpm dev
```

To check it: `pnpm typecheck`, `pnpm lint`, `pnpm test` (26 shared unit tests + 75 worker tests), `pnpm test:e2e` (6 tests) and `pnpm build`. None of them calls the Anthropic API. `KANBOT_RUNTIME=replay pnpm eval:agents` exercises the eval script for free; without `KANBOT_RUNTIME=replay` it runs real agents (ask first: it costs money).

## What was built

| Area | Where | Notes |
| --- | --- | --- |
| Path fence (M2 leftover) | `apps/worker/src/runtime/fence.ts`, `test/fence.test.ts` | Pure `checkToolCall()`: tool allowlist, every path or glob resolved (symlinks followed) and refused outside `cwd`, Edit/Write limited to the agent's `editScope`, Bash parsed quote-aware into argv and matched against `Bash(...)` rules as one plain command. 43 tests, including a table of escape attempts. |
| SDK adapter | `apps/worker/src/runtime/sdk.ts` | The hook runs `checkToolCall`; `permissionMode: "dontAsk"`; `blockReadsOutsideWorkingDirectories` as a second layer; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`; `plugins`; extra env per agent |
| Schema | `packages/shared/src/db/schema.ts`, `drizzle/0003_build_loop.sql` | `tickets.branch_name, worktree_path, bounce_count, touch_paths`; `comments.author_kind, agent_slug, file, line, resolved` |
| Transition table | `packages/shared/src/transitions.ts` | Build-loop rows, `verdict`-narrowed rows (QA `failed` reported vs crashed), `bounce` rows and `BOUNCE_LIMIT = 3`. 12 tests. |
| Verdict | `packages/shared/src/verdict.ts` | `touchPaths`, `comments`, `criteriaResults`, `crossTicketRisks` |
| Worktrees + checks | `apps/worker/src/worktree.ts` | `ensureWorktree` (creates or reattaches, runs `install` once), `snapshot`, `checkAfterRun` (branch, default branch, history rewrite, `.kanbot/`, edit scope) |
| Worker | `apps/worker/src/run.ts` | Worktree per build run, `{test}`-style placeholders from `project.yml`, stall rule, bounce counting, touch-set growth, comments/criteria/risks stored, recording |
| Context | `apps/worker/src/context.ts` | Criteria with ids, diff stat, unresolved review comments, latest review and test report, in-flight tickets (Nancy: all, with diffs capped at 1,500 lines; others: overlapping only) |
| Repo helpers | `packages/shared/src/repo.ts` | `git()` (execFile, no shell), `loadProjectConfig()` from the default branch, `overlap()`, `branchName()` |
| Agents | `agents/sir-codes-a-lot.md`, `nitpick-nancy.md`, `testy-mctestface.md`, avatars | Plus `plan-b.md`: plan title rule and Ponytail lite |
| Plugins | `plugins/ponytail/` (`VENDORED.md`) | Ponytail 5.3.3, trimmed to the mode hooks, the codebase map and two skills |
| Replay | `apps/worker/src/runtime/replay.ts`, `fixtures/runs/**` | `<scenario>.<n>.json` per attempt, fallback to `default.json`, patches applied as real commits, `$criterionN` placeholders, `record()` |
| Sample repo, golden tickets, eval | `fixtures/sample-repo/`, `fixtures/golden/`, `apps/worker/src/eval.ts` | Zero-dependency Node + TS todo app with a planted bug; 4 golden tickets; `pnpm eval:agents [--only=…] [--baseline]` |
| API | `apps/web/lib/tickets.ts`, `app/api/tickets/[id]/diff` | Overlap check (409 `overlap`, `startAnyway`), bounce reset on Planning, worktree removal on delete, `GET /api/tickets/:id/diff` |
| UI | `components/board.tsx`, `ticket-drawer.tsx` | Start-anyway confirm, `↩ n` on cards, Diff tab, comment bylines, branch in the header |
| Tests | `apps/worker/test/build-loop.test.ts`, `apps/web/e2e/build-loop.spec.ts` | Done criterion end to end on a real repo (worker + e2e), bounce limit, QA edit scope, stall, no repo, rewritten history, switched branch, overlap 409 |

New endpoint: `GET /api/tickets/:id/diff`. `POST /api/tickets/:id/move` takes `startAnyway` and can return 409 `overlap`.

## Key decisions

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

## Changes to the spec (`requirements.md`)

Every departure from the spec is edited into the spec itself. This list says where:

| Change | Why | Where in the spec |
| --- | --- | --- |
| **Path fence for every agent tool** (M2 leftover, not on any deferred list). The M2 hook checked tool names only, so Plan B could Read/Grep/Glob any file on the machine. Paths and globs outside `cwd` are now refused, symlinks followed. | Found after M2; it matters more now that agents edit and run commands | §8 step 4, §14 code safety, §16 "Deferred from M2" (new ✓ row) |
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

## What was left out on purpose

Everything cut from M3 is in "Deferred from M3" in `requirements.md` §16, with its milestone. Main items:
- Playwright-based QA and the other four plugins (M4);
- ticket links, WIP limits, Settings (M4);
- the other stall rules, rebasing before runs, commit trailers, worktree removal on Done, session resume on bounce (M4);
- the SDK sandbox and the write block (M4);
- a side-by-side diff (M5);
- clearing the top bar's agent notice when the run ends (M4).

New `shortcut:` comments:
- glob-vs-glob overlap is approximate;
- stall detection has the repetition rule only;
- a worktree whose agent is still stopping can survive a ticket delete;
- the diff is unified only;
- a file already dirty before a run and edited further by it is not caught by the edit-scope check;
- the agent notice stays up until the next move.

## Real-agent smoke test

The golden bug ticket ("Deleting an unknown todo removes the last one", the bug planted in the sample repo) ran end to end with the real SDK: `KANBOT_RECORD=1 pnpm eval:agents --only=bug`. Plan B planned it, its plan was approved automatically, then Sir Codes-a-Lot, Nitpick Nancy and Testy McTestface ran. It ran twice in total; with your OK for $2–4, the two runs cost **$0.59**.

**Run 1 (before fixes): Blocked after Code Review, $0.31.**

| Agent | Result | Cost | Time |
| --- | --- | --- | --- |
| Plan B | success: right root cause, 4 criteria, touch set | $0.08 | 18 s |
| Sir Codes-a-Lot | success: correct fix plus 2 tests, committed | $0.19 | 50 s |
| Nitpick Nancy | approved, but the run **failed the post-run check** | $0.04 | 11 s |

It found three problems, all fixed before run 2:
- **The post-run check blamed the wrong run.** Codes's commit messages (multi-line, with backticks) were refused by the fence, which is correct: backticks inside double quotes execute. He worked around it by writing `.git-commit-msg.txt` and `git commit -F`, then couldn't delete the file. The check after *Nancy's* run counted that leftover file as her change. Each check now counts only files that became dirty during its own run. A test covers it.
- **`git status --short` was refused**, because the rule was exact. `git status` is now a prefix rule.
- **The prompts didn't say how to write commit messages.** Codes's and Testy's prompts now say: inline `-m` lines, no backticks, `$`, `\` or newlines, never a message file, and no stray files.

**Run 2 (after fixes): reached QA with no bounce, $0.28, 92 s.**

| Agent | Result | Cost | Time | Tokens in / out |
| --- | --- | --- | --- | --- |
| Plan B | success: 4 criteria, touch set `src/todos.ts`, tests | $0.06 | 20 s | 34k / 1.8k |
| Sir Codes-a-Lot | success: fix + regression tests, one commit | $0.13 | 36 s | 106k / 3.1k |
| Nitpick Nancy | approved: no blocking issues | $0.03 | 10 s | 41k / 0.6k |
| Testy McTestface | success: added a DELETE API test, 9/9 tests pass, all 4 criteria marked pass | $0.07 | 25 s | 117k / 2.2k |

The branch ended with `3 files changed, 26 insertions(+), 1 deletion(-)` and the default branch untouched. Results were saved locally to `evals/results/` (gitignored).

What the recordings showed after run 2:
- **One more fence bug:** it treated Grep's `pattern` (a regex) as a path, and on Windows `\.remove\(` looks absolute, so Codes's search was refused. Only Glob's `pattern` and Grep's `glob` are paths now; a test covers it.
- Codes and Testy each had one Bash call refused for shell characters; both rephrased and carried on.
- Testy tried to add a commit trailer with `<email>` in it; the fence refused the `<`. The trailers belong to the worker anyway (FR-42, M4).
- Nancy approved with 2 tool calls. That's thin for a review, but the diff was 3 files. The golden "review" ticket is the real test of her, and it hasn't run with real agents yet.

## Hardening pass: more simulations and the full golden eval

Asked for after review: "make sure this part is solid". With your OK, I made two real passes of all four golden tickets (`KANBOT_RECORD=1 pnpm eval:agents --baseline`). They cost **$2.81**: $1.41 for the first and $1.40 for the second. Together with the smoke runs, M3's real spend is **$3.40**.

**Free tests added (worker 29 → 72):**
- Replay scenarios:
  - a QA failure bounces back to In Progress, then passes;
  - Nancy approving with a *blocking* cross-ticket risk becomes a bounce, with the note on both tickets;
  - two tickets build side by side in one repo without mixing branches, and Nancy's context shows the other one;
  - a deleted worktree is recreated from its branch, commits kept;
  - a cancel mid-build leaves the worktree on its branch, and the next run carries on;
  - an agent that edits between identical test runs isn't stopped as a stall;
  - all four golden recordings replay to QA.
- **Fence attack table:** 33 escape attempts that must be refused (quotes, brace expansion, `~`, UNC and drive paths, `--output`/`-C`/`--git-dir`, `-F ../file`, newlines, substitutions), plus in-repo calls that must stay allowed.
- **Mutation check:** breaking the QA-failure bounce row fails the new test. Then restored.

**Bugs found and fixed:**

| Bug | Found by | Fix |
| --- | --- | --- |
| Brace expansion got past the fence: `{..,src}/x` in Bash, Glob `pattern` or Grep `glob` reaches the parent folder | Fence attack table | Each brace alternative is checked on its own |
| `~/x` in a Read/Edit/Write path was treated as a folder named `~` inside the repo, but the tools expand it to the home folder | Fence attack table | Paths starting with `~` are refused |
| Commit messages were path-checked word by word, so a message mentioning `/api/todos/:id`, or a `<email>` trailer, was refused. The review ticket's real run ended `needs_input`, uncommitted | Real pass 1 | Bash is parsed into argv, quotes included: `<`, `;` or `(` inside quotes are literal and allowed, and `git commit -m` text isn't checked as paths. `$`, backticks, `\` and newlines are still refused everywhere. This was the M3 `shortcut:` comment; it bit |
| The stall rule fired on Testy re-running `node --test` after each fix to his own test (UI ticket), stopping him just before he committed | Real pass 1 | An Edit/Write/NotebookEdit resets the repetition count. Spec §8 updated |
| Every agent session listed 20 skills nobody configured (Claude Code's bundled ones, such as `deep-research` and `design`), adding context to every turn | Real pass 1; the run log now records `plugins` and `skills` from the SDK's init message | `skills` is limited to our plugins' skills. Three bundled plugins still load (deferred to M4, see the spec) |

Ponytail is confirmed loaded in every real run: `ponytail` appears in each init event's plugins.

**Real pass 2 (after the fixes): all four reached QA, no bounces, $1.40, saved as `evals/baseline.json`.**

| Ticket | Cost | Time | Diff |
| --- | --- | --- | --- |
| bug: Deleting an unknown todo removes the last one | $0.34 | 86 s | 3 files, +23 −2 |
| feature: Todos can have a due date | $0.43 | 121 s | 5 files, +61 −8 |
| review: Rename a todo | $0.37 | 102 s | 4 files, +83 |
| ui: Show how many todos are left in the heading | $0.26 | 91 s | 2 files, +82 −1 |

Only one tool call was refused across the whole pass: Testy tried `node -e "…appendFileSync(…)"` with backticks. That refusal is correct, and he used Edit instead.

The recordings are kept as `fixtures/runs/*/golden-*.1.json` (no local paths, user name or key; checked with grep). `KANBOT_RUNTIME=replay pnpm eval:agents` reproduces the baseline for free.

**What the real runs did not cover:**
- **No real bounce.** On the review ticket, Sir Codes-a-Lot ignored the owner's `Object.assign` hint and built it safely with tests, so Nancy had nothing to push back on. Bounces are proven by replay tests only. A better golden ticket is on "Deferred from M3".
- Nancy's reviews are short: 2–6 tool calls, and she runs neither the tests nor the linter. That's acceptable for these small diffs, but it's untested on a large one.
- On two tickets Testy found the branch's tests already covered every criterion, so he added none. That's correct, but it means QA added little.
- One pass per ticket is a small sample. Costs varied about ±15% between passes.

## Problems found and fixed while building and testing

- **The SDK docs changed the fence design** (found while re-checking them before writing runtime code). Read-only Bash commands are auto-approved in every mode, so the plan's "let the SDK's rules match Bash" would have left `cat` and `ls` open. The hook matches Bash itself.
- **A QA run that crashed would have bounced to In Progress** (found while writing the rows). It ends in state `failed`, the same as a QA verdict of `failed`. Rows can now require a reported verdict, with a unit test for each case.
- **CRLF.** Kanbot's checkout uses `autocrlf=true`, so the sample repo would be checked out with CRLF and replay patches wouldn't apply. Fixed with `.gitattributes`.
- **Worker test files could claim each other's runs.** `claimNext` is global, so the worker's Vitest now runs files one at a time.
- **Test command was exact-match.** `Bash({test})` would have stopped Testy running one test file; `{test}` and `{lint}` are now prefix rules. `{install}` and `{build}` stay exact, so `install` can't add packages.
- **I broke a rule on purpose.** Sending Nancy's change requests to QA instead of In Progress makes 2 unit tests and 2 worker tests fail. Then restored.
- `pnpm format` rewrote line endings in files M3 didn't touch. Content is unchanged, and git normalizes them on commit.

## Pre-merge verification (2026-11-03)

Run before the PR, with no code changes:
- `pnpm db:migrate` on the existing dev database, typecheck, lint, `prettier --check`, `pnpm test` (26 + 75), `pnpm test:e2e` (6), `pnpm build` and `KANBOT_RUNTIME=replay pnpm eval:agents`: all pass. A throwaway browser walkthrough of M1 → M2 → M3 on the replay worker passed 11/11 steps.
- Real agents, $2.17 total. One new ticket ("Todos can be renamed") went Backlog → Planning → Ready → In Progress → Code Review → QA in about 2 minutes for $0.45, with all 6 criteria passing. In the golden eval ($1.72), all 4 tickets reached QA. The eval flagged 2 bounces against the baseline's 0: Nancy's cross-ticket review caught that the due-date ticket would break the rename ticket's tests once both merged. That is the feature working, and it depends on run order, so the baseline was kept.
- Found: the agent notice stays up after the run ends (deferred to M4).

## Known risks

- **Agents run real commands on your machine.** `{test}` runs whatever the repo's test script does. The fence stops agents from *naming* outside paths, but test code they write can still read or write anywhere the worker's user can. That is why container mode exists in the spec (Later). Point Kanbot only at your own repos.
- **The write block is the hook's alone.** `blockWritesOutsideWorkingDirectories` needs Claude Code 2.1.314; the pinned SDK bundles 2.1.304. Upgrade the SDK when 0.3.31x has aged past pnpm's minimum release age.
- **Agent commits use your git identity** until the GitHub App (M4).
- **Real runs cost money.** Budgets: Codes $1.50, Nancy $0.75, Testy $1.00, Plan B $1.00 per run. There is no daily cap until M4, and a ticket that bounces 3 times can cost about $10.
- **Tested only on Windows**, as with M1 and M2.

**Please review the three new agent prompts** (`agents/sir-codes-a-lot.md`, `nitpick-nancy.md`, `testy-mctestface.md`) and the Plan B title rule. Prompt quality decides agent quality, and one smoke ticket is a thin sample.
