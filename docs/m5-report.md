# M5 report: ship and deploy

Status: **in progress (living document, updated as each phase lands).** Branch `m5-ship-and-deploy`, started 2026-11-06. Phases 1 to 3 are merged into `main` (PR #10, 2026-11-07). Phase 4 is merged too (PR #11, 2026-11-07, merge `a3242da`). It includes QA needing a start command, project env vars and the `http_request` fence fix, and `pnpm eval:agents` passes. The owner tests everything at the end of the milestone. Phase 5a (Captain Ship-It opens the PR) and phase 4b (QA's browser, pulled forward) are merged too (PR #12, 2026-11-08, merge `409f094`), with `pnpm eval:agents` passing. 5a's own paid eval (with 5b) and its real run on a test repo are still to do. Phase 5b (watching GitHub) is built on branch `m5-watch` and stopped for review; its real run on Neural-Noir-Website is next.

**Done when:** a ticket goes from Backlog to a human-approved, merged PR.

## Owner decisions at the start (2026-11-06)

- Docker on the Droplet runs **rootless**. The worker uses the plain `docker` CLI against that socket; there is no socket proxy.
- **There is no Droplet or domain yet.** Everything is built and checked locally first: a dev GitHub App on localhost, with polling instead of webhooks. The server setup is written down as steps, and the real deploy is checked once the server exists.
- Onboarding steps 8–9 (Plan B suggests hotspot groups; Kanbot drafts CLAUDE.md and a security note as a PR) **move to M6**.
- **Later the same day: Kanbot runs on the owner's PC, in its own WSL distro, not on a Droplet.** A paid Droplet was more than the owner wanted for now, and DigitalOcean's student credit ended in July 2026. Nothing in M5's "done when" needs a public server: GitHub sign-in works on localhost, and Kanbot polls GitHub every 60 s instead of receiving webhooks. A public server (any Ubuntu VPS, e.g. Oracle Cloud's free tier) moves to M6 as optional.

## Phases

| # | Phase | State |
| --- | --- | --- |
| 1 | Project commands in the project's own image | **done** (2026-11-06) |
| 1b | Kanbot builds the image from a devcontainer's Dockerfile by itself | **done** (2026-11-06) |
| 2 | Dockerfiles, compose `web`/`worker`/`caddy`, deploy workflow, nightly cleanup, `docs/deploy.md` | **done locally** (2026-11-06) |
| 2b | Run Kanbot in WSL; a default image so project code never runs in the worker's container | **done** (2026-11-06); the owner's own `kanbot` distro is set up from `docs/deploy.md` |
| 3 | GitHub App two-click setup, Sign in with GitHub, auth on every route | **done** (2026-11-07) |
| 4 | Onboarding (§10 steps 1–7 and 10) | **done and merged** (PR #11, 2026-11-07), checked for real on NetGPT. Also in it: QA needs a start command, project env vars, the fence fix; eval passes |
| 5a | Ship: Captain Ship-It's agent file; push the ticket branch; open the PR; store pr\_number, pr\_url and head\_sha on the ticket; commit trailers and the bot identity (FR-42, FR-43); Ship/Done move confirmations | **merged** (PR #12, 2026-11-08); tests, e2e and the browser check pass. Still to do: Ship-It's eval (with 5b, paid, owner's OK) and the real run on a test repo the owner names |
| 4b | QA's browser, pulled forward from M6: Testy opens the QA app in headless Chromium (viewport, read, click, type, console errors, screenshots), fenced to the app's origin; screenshots on the ticket; Testy's prompt asks for rendered evidence | **done and merged** (PR #12, 2026-11-08); tests, e2e and the browser check pass, and the eval passes |
| 5b | Watch GitHub: a 60 s poll for CI status, reviews and merges. CI failing bounces to In Progress with the log; changes requested imports the comments and bounces; a merge goes to Done (Archie), a closed PR to Backlog; the owner's own pushes are detected and never rewritten (FR-44 polling, FR-46, FR-47, FR-48); CI on cards and in the drawer | **built** (2026-11-07, branch `m5-watch`); tests, e2e and the browser check pass. Real run on Neural-Noir-Website done (M5's "done when", 2026-11-07). Still to do: Ship-It's eval (paid, owner's OK) |
| 5c | Keep branches current: rebase onto the default branch before each run; rebase overlapping branches when main moves (FR-51); GitHub status in `/api/health` | **proposed**, not started. Ends with two tickets in flight while main moves |
| 6 | Leftovers: `blockWritesOutsideWorkingDirectories`, SDK `sandbox`, SSE `Last-Event-ID`, the disk-over-90% guard | not started |

The public server (Caddy, HTTPS, webhooks, the deploy workflow on a real host) moved to M6 (2026-11-06).

## Progress log

- **2026-11-06.** Planned M5 and created this report and the branch.
- **2026-11-06.** Phase 1 done: project commands run in the project's image. Tests, e2e and the Settings browser check pass (see "Checks run"). Stopped for the owner's review before phase 2.
- **2026-11-06.** Owner review: the image should come from the repo's Docker files without a trip to Settings. A devcontainer that *names* an image already worked; one that *builds* from a Dockerfile didn't. Decided: phase 1b, where Kanbot builds the devcontainer's Dockerfile itself, from the default branch only. A plain root `Dockerfile` is ignored, because it's usually a production image without test tools. Guessing an image from the language (package.json, go.mod, …) goes with phase 4's command detection. Then phase 2.
- **2026-11-06.** Phase 1b done: a devcontainer that builds from a Dockerfile now gives the project its image with no Settings step. The Settings help text says so. Tests (including a real Docker build), e2e and the browser check pass. Next: phase 2.
- **2026-11-06.** Phase 2 done locally: the deploy files, `docs/deploy.md` (Droplet setup step by step) and the nightly cleanup. A separate check stack (`-p kanbotcheck`, its own database on :5433, replay runtime) ran migrate, web and worker from the new images. Plan B's run went through them, and the worker started a project container and reached its port on 127.0.0.1. Caddy was left out of the local run, because it publishes 80/443 on every interface of the owner's machine; its config was validated on its own. Next: phase 3 (GitHub App and login). The real deploy waits for the Droplet.
- **2026-11-06.** Owner review: is a Droplet needed at all? No: M5's goal can be reached on the owner's PC. Decided: run Kanbot in its own WSL distro, the public server becomes optional (M6). While explaining how projects get their image, a security gap came up: a project with no image ran its code inside the worker's container, which holds the Docker socket. Phase 2b covers both.
- **2026-11-06.** Phase 2b done. The full stack ran in the owner's Ubuntu WSL (its native Docker Engine, separate from Docker Desktop), reached from Windows at `localhost`, and a replay ticket went from In Progress through review to "QA passed, awaiting approval". The check found three bugs, all fixed: the web container had neither git nor the repos (adding a project with a repo failed), a failed image download was reported as the agent's failing tests (bouncing the ticket), and WSL stopping an idle distro restarted the stack. Next: phase 3.
- **2026-11-06.** Stopped for the day. To pick up: (1) the owner sets up the `kanbot` WSL distro from `docs/deploy.md` setup A, which is the first real test of rootless Docker; (2) phase 3, the GitHub App and Sign in with GitHub, on localhost. Branch `m5-ship-and-deploy` has phases 1, 1b, 2 and 2b committed and is not pushed.
- **2026-11-07.** Picked up. The `kanbot` WSL distro isn't set up yet; the owner chose to do phase 3 first.

  Owner decisions:
  - auth is never switched off; tests and browser checks sign a session with test secrets;
  - the owner is the account that creates the App;
  - before an App exists, setup is reachable on localhost only (a server's first setup goes over an SSH tunnel).

  The owner also asked which repos the App is for: the ones Kanbot manages, picked at install time, not Kanbot's own repo.
- **2026-11-07.** Phase 3 built: the two-click setup, Sign in with GitHub, and a session required on every route. Tests, e2e and the browser check pass. The browser check found a bug: Next reports `localhost` as the origin of a request made to `127.0.0.1`, so GitHub would have sent the owner back to a host without their state cookie. URLs and cookies now use the browser's own Host. The owner then did the real round trip; it worked after one fix (below). Next: phase 4.
- **2026-11-07.** Real round trip done: the App `kanbot-6527ff` is created and installed on `MatthewOsorio/NetGPT`, and the owner signed in. GitHub refused the first manifest because its (inactive) webhook URL was localhost, so the manifest no longer has a webhook.
- **2026-11-07.** Phases 1 to 3 merged into `main` as PR #10 (merge `62929d7`) after CI passed (checks and image build). The deploy workflow stays off (`KANBOT_DEPLOY` is unset). Next: phase 4, onboarding, with NetGPT as the first repo.
- **2026-11-07.** Phase 4 planned on branch `m5-onboarding`. NetGPT, read-only through `gh`: public, Python, no dependency file, no tests, no CI, `main` unprotected.

  Owner decisions:
  - **Baseline:** a command that already fails on the default branch is skipped by the checks gate, and agents are told it was already failing.
  - **Local-folder projects stay**, tucked under "Use a local folder instead"; the API keeps `repoPath` for tests and the eval.
  - **Branch protection binds admins too** (`enforce_admins`).
- **2026-11-07.** Phase 4 built: the repo picker, clone, command detection, baseline, the starter CI PR, branch protection, and agents held off until setup is done. Tests, e2e and the browser check pass. The browser check found one bug: cloning into a folder that already holds Kanbot's clone (a retry, or a key reused after deleting a project) failed, because git won't fetch into the checked-out `main`. It now fetches and resets instead. Next: the real run on NetGPT with the owner (it opens a PR and changes `main`'s protection on their repo, so those clicks are theirs), then phase 5.
- **2026-11-07.** Real run on NetGPT, steps 1–4, through the UI on `localhost:3000` against the real GitHub App (worker on the replay runtime, so no agent could spend). The repo picker listed `MatthewOsorio/NetGPT`. The clone went to `.kanbot-repos/ng`, and its `.git/config` holds no token. Detection proposed exactly what was expected: build `python -m compileall -q .`, no install, test or lint, image `python:3.12-bookworm`, Python test globs. The first baseline failed because Docker Desktop could not unpack the image ("failed to Lchown … no such file or directory", a containerd error on Docker's side). The step showed the error, and **Try again** pulled the image and passed the build, with no container left behind and the throwaway worktree removed. The CI step saw, through the real API, that NetGPT has no workflows. Stopped before **Open CI pull request**: it commits to the owner's repo, and Claude Code's permission check left that click to the owner.
- **2026-11-07.** The owner finished steps 6–7 in the UI, and both are checked on GitHub. PR #1 "Add CI for Kanbot" (branch `kanbot/onboarding-ci`) was opened by the App, and Kanbot CI passed on the push and on the PR; the PR is merged. `main`'s protection is exactly §10's rules: 1 approving review, required check `ci` (strict), `enforce_admins` on, no force-push or deletion. The project is Ready. The owner then moved a ticket (NG-1) to Planning, and its "plan" was about Kanbot: the worker was still on the replay runtime from the test, which plays a recorded sample-repo plan (its $0.12 is the recording's, nothing was spent). The worker now runs on the SDK runtime. **Phase 4 is done on a real repo.** Next: a real Plan B run on NG-1 (paid, the owner's click), then phase 5.
- **2026-11-07.** The owner's ticket NG-2 ("a very simple UI") ran with real agents: Plan B ($0.18), Sir Codes-a-Lot ($0.20), Nancy ($0.09) and Testy ($0.06). Testy passed it on a code read alone. NetGPT's only command was the build, so Testy had no test command and no app to start. Sir Codes-a-Lot couldn't run `python -m unittest` for the same reason: it isn't a project command. NG-2 then waited in QA as "Approve · needs you", with no button to approve it; approving meant dragging it to Ship. **Owner's decisions:** QA must be able to run something (a test command with test globs, or a start command), and "Approve and ship" goes on the ticket now. Built:
  - Onboarding's commands step won't move on without such a command.
  - A move into QA without one is refused (409 `qa_setup`), and Code Review's success holds the ticket in Code Review, flagged "Needs you", with the reason. No Duckworth run is spent on a settings problem.
  - Testy's code-read fallback is gone: behavior passes only on evidence from the app or a test, else `needs_input`.
  - The drawer has an **Approve and ship** button, which moves the ticket to Ship. It waits there until Captain Ship-It (phase 5).

  The owner then tightened it: **QA needs a start command**, because QA's job is to run the app. A test setup alone no longer counts. The setup page marks Start as "Not found in the repo. Required" when detection didn't find one. For NetGPT, a tkinter app, this means QA can't pass until desktop apps can be driven (a virtual display, M6 QA row) or NetGPT gets a web UI.

  Testy's prompt changed, so `pnpm eval:agents` is due before merging (paid; owner's OK). For NetGPT, Install `pip install --user pyshark openai` and Test `python -m unittest` in Settings still give the checks gate and Testy's tests something to run. Commands run in `python:3.12-bookworm`, and the packages land in the shared cache volume.
- **2026-11-07.** Owner asked that onboarding account for projects needing env vars (API keys, connection strings). **Owner's decisions:** every project command gets them, the agents' own project-command calls included; and CI reads them from the repo's Actions secrets, which the owner adds on GitHub (Kanbot doesn't write secrets to GitHub). Built: stored encrypted and write-only; names proposed from `.env.example`; passed to every project command, through an env file in containers; redacted from what Kanbot stores; listed in the starter workflow. Tests, e2e and the browser check pass.
- **2026-11-07.** `pnpm eval:agents` for Testy's prompt change (owner's OK). The first run failed: `feature` and `security` were blocked after QA. Every `http_request` call had been refused with "/api/todos is outside this run's working directory". The permission hook checked the tool's `path` field as a file path. **This bug predates this branch.** Testy's code-read fallback had hidden it, and with the fallback gone Testy rightly reported `needs_input`. Fixed in `fence.ts`: the HTTP tool skips the file-path checks, since `appRequestUrl` already keeps it on the app. A fence test was added. The second run passed: all 5 golden tickets reached QA and ended in Done, within the baseline's bounces and cost (about $2.57). Testy now checks API criteria against the live app. Page criteria are still checked by reading code or by stub-DOM tests, because there's no browser (the Playwright row on M6). Results: `evals/results/2026-11-07T22-28-30-615Z.json` (failed run) and `…22-39-55-470Z.json` (passing run).
- **2026-11-07.** Phase 5 planned with the owner, to start next session. **Proposed:** split it into 5a, 5b and 5c (phase table), with plan mode, tests against the GitHub stub, e2e and a browser check for each part, and a stop for review after each.
  - **A test repo is needed first.** NetGPT can't reach a merged PR: it's a desktop app, so its QA can't pass (§4). Proposed: a small throwaway GitHub repo made from `fixtures/sample-repo`, a web app the eval agents already handle. The real run at the end of 5b pushes branches and opens PRs on the owner's GitHub, so those clicks are the owner's.
  - **Ship-It is a new agent**, so `pnpm eval:agents` must reach PR Review (§8) with the GitHub stub, and each paid run needs the owner's OK.
  - **Open decisions** (the owner answers at the start of next session; recommendations in bold):
    1. Who pushes and opens the PR? **The worker's own code; Ship-It only writes the PR description, changelog and docs, so no agent holds a GitHub token.** The alternative is giving Ship-It push and PR tools.
    2. Where does the owner merge? On GitHub only, or also with a Merge button in Kanbot (the spec's FR-47: enabled only after a human approval)?
    3. The "small fix" checkbox (§10 PR Review: a requested change skips straight back to PR Review): build it in 5b, or defer it to M6?
  - The working branch for phase 5 starts from `main` and carries the uncommitted doc fixes (this report's status, the spec's "Where things stand" and `CLAUDE.md`'s status line).
- **2026-11-07.** Phase 5 started. **Owner's decisions:**
  1. The worker pushes and opens the PR with the App's token. Ship-It only writes the PR description, the changelog entry and docs, so no agent holds a GitHub token.
  2. Merging happens on GitHub only. The Merge button (FR-47) went to the M6 table; 5b detects the merge.
  3. The "small fix" checkbox went to the M6 table.
  4. The real run uses a web-app repo the owner names later (not NetGPT, whose QA can't pass).
- **2026-11-07.** Phase 5a built on branch `m5-ship`:
  - Ship-It's agent file;
  - the push and the PR;
  - the PR fields on the ticket;
  - commit trailers and the bot author;
  - the move confirmations for Ship, PR Review and Done.

  Typecheck, lint, 59 shared + 129 worker tests, 16 e2e specs and the browser check pass. Stopped for review. Still to do before 5b: `pnpm eval:agents` for the new agent (paid; owner's OK), and the real run on the test repo. That run pushes and opens a PR on the owner's GitHub, so the clicks are theirs.
- **2026-11-07.** The owner's first test on a Vite site (Neural-Noir-Website) stuck at QA. Two Kanbot bugs:
  1. On Windows, every project command an agent ran in the project's image was refused. The `MSYS_NO_PATHCONV=1` prefix on the rewritten `docker run` trips Claude Code's own permission check. Fixed: the SDK runtime sets that variable in the agent's environment instead.
  2. QA's app never answered: Vite ignores `PORT` and listens on localhost only, which a container's published port can't reach. The owner asked for the worker to handle any technology, not a per-tool list. Fixed: a forwarder container (`alpine/socat`) owns the app's network; the app joins it, and the worker finds whatever port the app listens on (`/proc/net/tcp`) and forwards to it from inside, so a plain `npm run dev` works whatever port or host it picks. Checked with real Vite (`npm run dev`, untouched), and in tests with a localhost-only server, an IPv6-only one, one that reads `PORT` and `python -m http.server`. Onboarding proposes a `dev` script when there's no `start`. A Start command may also say `$PORT`.

- **2026-11-07.** On NNWEB, Testy blocked on "visible without scrolling at <768px and desktop": with only `http_request` it can't render a page, and it rightly won't pass a visual criterion on a code read. The owner pulled QA's browser forward into M5 (phase 4b). 5a was committed first (`e467bd1`, local). **Built:**
  - Kanbot's own browser tools on its in-process MCP server (`apps/worker/src/runtime/browser.ts`), on `playwright-core` 1.64.1, the version e2e already locked: `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_screenshot`. Each result lists the console errors since the last call. The plugin was the alternative; see "Key decisions".
  - The fence is in the browser context: every request off the app's origin is aborted, WebSockets to other hosts are closed, and service workers are blocked. The permission hook lists the tools on QA runs only and skips the file-path check for them, as for `http_request`.
  - Screenshots go to a new `screenshots` table (migration `0016_screenshots`). They show as thumbnails under the run's test report in the drawer and open full size from `GET /api/screenshots/:id`. The Live log shows `[image]` instead of the base64.
  - Testy's prompt: rendered evidence for what a user sees or does, phone 375×812 and desktop 1280×800, one screenshot per visual criterion, and the owner's observation in `<owner_answer>` counts as evidence. `<qa_setup>` names the browser tools.
  - The worker image installs Chromium's headless shell with its libraries (`--only-shell --with-deps`).
  - Replay scripts can carry `screenshots` (PNG files), so tests, e2e and browser checks get real screenshots without a browser.

- **2026-11-08.** PR #12 (5a and 4b) opened, CI passed (`check`, `images`), merged into `main` (merge `409f094`). The local checkout is on `main`. After pulling: `pnpm db:migrate` (0015, 0016) and restart `pnpm dev`. Next: phase 5b.
- **2026-11-07.** Phase 5b planned and built on branch `m5-watch`. **Owner's decisions:** a repo with no CI workflows is detected and its ticket goes straight to PR Review; the real run uses Neural-Noir-Website. Built: the GitHub watcher (60 s poll), `GITHUB_RULES`, the fast-forward of the owner's pushes, CI and review badges, PR Review in Needs me. Tests, e2e and the browser check pass (see "Checks run"). Stopped for review. Still to do: the real run (the owner merges on GitHub) and Ship-It's eval (paid; owner's OK). After pulling: `pnpm db:migrate` (0017).
- **2026-11-07. M5's "done when" reached for real.** On Neural-Noir-Website (private repo, no Actions workflows; Vercel's preview check is its only check), with real agents: Plan B, Sir Codes-a-Lot, Nancy and Testy passed it to QA; the owner approved the ship; Captain Ship-It ($0.05) opened PR #1. The watcher read Vercel's completed check as CI passing and moved the ticket to PR Review; the owner merged on GitHub, and on the next tick the ticket moved to Done, its worktree was removed and Archie started. Not exercised for real: a GitHub approval (the owner merged without one; the repo is private on a free plan, so GitHub doesn't enforce branch protection there), red CI and requested changes (covered by tests against the stub).
- **2026-11-08. A harder real run on Neural-Noir-Website** (the owner asked for one in place of a golden-ticket eval). NNWEB-4, "Data-driven team page with a profile page per member": team data moved into `src/data/team.js`, a `/meet-the-team/:slug` route with a not-found state, per-page tab titles, lint and build passing. All real agents, no bounces, **$0.85** in total: Plan B $0.21, Sir Codes-a-Lot $0.37 (9 files, +178 −66, lint and build run), Nancy $0.10, Testy $0.10 (browser at 375 and 1280 px, 4 pages, 3 screenshots), Ship-It $0.07 (PR #2), Archie $0.004. Vercel's check moved it to PR Review; the owner merged and the watcher moved it to Done. Found:
  - **The clone's `main` goes stale.** New ticket branches start from the clone's local default branch, which nothing pulls after a merge: it was 3 commits behind (PR #1 missing), so NNWEB-4 would have conflicted on CHANGELOG.md. Fast-forwarded by hand for this run. **Fixed:** before each run on a GitHub project, the worker fast-forwards the clone's default branch from GitHub (`pullDefaultBranch` in `ship.ts`; best effort, it warns on failure). Rebasing existing ticket branches is still 5c.
  - **Nancy claimed a security review she didn't do.** 11 seconds, 5 turns: one `git diff`, then she loaded the security-review skill and reported at once, writing "the security review turned up nothing". Her verdict was reasonable for a static front-end change, but the claim isn't. **Fixed in her prompt:** loading the skill isn't running it; her review must carry a Security line naming each entry point she traced (or why there are none), and she may not claim a clean review she didn't do. `pnpm eval:agents` **passed** (2026-11-08, $2.76, every ticket to Done, the review ticket's 1 bounce as in the baseline). Each of Nancy's six reviews now traces the changed entry points (e.g. the PATCH body through `readJson` to `todo.title`; the bold titles' `textContent` and `ariaLabel`). On the UI ticket she put the trace in her summary and stored no review artifact; the worker doesn't require one on success.
  - Testy can't run lint or build (QA has no project commands) and leaned on the build run's result for that criterion. Fine here; worth knowing.
- **2026-11-08.** Lean-up on branch `lean-up`, no behavior change apart from one fix. The fix: the API key and `KANBOT_RECORD` were read at import, before `.env` loads, so under `pnpm dev` the key wasn't redacted from run logs; both are now read when used, with a test. `run.ts` was split into `queue`, `stall`, `finish`, `results` and `run`; `worktree.ts` into `docker`, `commands`, `qa-app` and `worktree`; the drawer and board into one file per job. Near-copies were merged (`ticketChanged`, `columnEnd`, one avatar, one artifact card, the shared sections and query in `context.ts`), and redaction moved from the replay runtime to `runtime/redact.ts`. Agents' prompts did not change: the old and new `context.ts` gave byte-identical prompts in 420 combinations of column, ticket and repo state, so no paid eval was needed. The M1 to M4.5 reports became `docs/history.md`. Tests, e2e, the replay eval and the browser check pass.
- **2026-11-08.** CI hardening on branch `ci-hardening`, from an audit against common AI failure modes. Added a `guards` job that fails PRs weakening the checks, type-aware lint, knip, `prettier --check`, a migration drift check, a coverage floor (worker 76% lines, shared 43%), required assertions, a block on real network calls in tests, e2e against a production build, a nightly shuffled run, secret scanning and a tighter deploy trigger. The shuffled run found one order-dependent test (QA browser "types and clicks"), fixed. Sign-in now has a happy-path e2e test, since the OAuth routes can reach the GitHub stub. **Departs from the audit plan:** `guards` uses `pull_request_target` so it runs from the base branch and a PR can't disable it; it therefore first runs on the PR after this one. **Still open:** the repo goes public for branch protection (owner's decision, after a pre-flight); `pnpm eval:agents` is due for the Ship-It, Nancy and Testy changes since the 2026-11-06 baseline (paid; owner's OK).
- **2026-11-08.** Second hardening pass on branch `ci-hardening-2`. GitHub settings: `guards` is now a required check, the six override labels exist, secret scanning, push protection, Dependabot alerts and CodeQL are on. Guards: renames out of the test pattern, `it.fails`, literal `expect`s, double casts and silent catches no longer pass; security files, install settings and existing replay fixtures need a label; destructive migrations get their own label; a baseline must carry the hash of the agents it ran on. Added `repo-rules.test.ts`, a signed-out e2e over every API route, the web app's first unit tests, the unsafe-`any` lint family (25 violations fixed in code) and a Claude Code hook refusing the owner's commands. **Changes to the spec:** §15 records all of this. **Owner's decision:** no machine account, so AI sessions keep the owner's token and the hook is a seatbelt, not a boundary; required approving reviews stay at 0. **Still open:** the next agent change needs a real `pnpm eval:agents --baseline` (paid), since the current baseline has no `agentsHash`.
- **2026-11-09.** CI simplified on branch `ci-simplify`, at the owner's request: the two hardening passes had made it hard to follow, and it went red on its own (the nightly shuffled run on `main`, Dependabot's workflow bumps waiting on a label). **Owner's decision:** no guards. Removed the `guards` workflow and `ci-guards.ts` with its six override labels, gitleaks (GitHub's secret scanning and push protection are on), the lockfile audit (Dependabot alerts), actionlint, the nightly shuffled run and the baseline's `agentsHash`. CI is now `ci.yml` alone, the same checks on every PR, each one a command that runs locally. Three conventions the guards checked on changed files are now whole-tree tests in `repo-rules.test.ts`: `route()` on API handlers, web and worker apart, no `localeCompare`. Fixed the order-dependent `encrypt` tests the nightly run found. **Given up:** nothing in CI stops a PR from loosening the checks, deleting tests, editing a migration, adding a dependency or changing an agent without an eval; the owner's review is the gate for those. **Changes to the spec:** §8 (the owner checks for a new baseline), §15 (CI). **Owner steps:** remove `guards` from `main`'s required checks before merging, then delete the six labels. The hook still refuses label changes; its edit was refused in the AI session, so dropping that rule is the owner's. The "Still open" baseline item above is moot.
- **2026-11-09.** CI made sturdier on branch `ci-solid`, with no guards and no labels. Each check is a whole-tree test or a few lines in `ci.yml`, and none can go red unless a PR actually does what it checks. **Owner's decision:** take back one item from the "Given up" list above, editing a migration, as a check that fails, and list the rest as warnings. Added: (1) Dependabot groups only minor and patch updates, so each major gets its own PR. #19 had been red since 11-08 because TypeScript 7, which typescript-eslint doesn't support yet, was grouped with 15 safe bumps. (2) `repo-rules.test.ts` fails on any unconditional `.skip`/`.todo`/`.fails`/`.fixme`, and pins today's four conditional skips, so `skipIf(process.env.CI)` can't slip in. (3) On a PR, editing or deleting a migration already on `main` fails. CI starts from an empty database and can't see it, and drizzle never re-runs an edited migration on the real one. (4) On a PR, a non-blocking list of the changes only the owner can judge, as warnings plus a run summary: the checks' own config, security boundary files, existing replay fixtures, deleted test files, agent files (which need `pnpm eval:agents`) and `package.json`. Verified locally: the step on a scratch commit failed on an edited migration, and warned on exactly the four risky files of seven while a new migration, a new fixture and an avatar passed. The skip test failed on a scratch `it.skip` and on `it.skipIf(process.env.CI)`. The full local run then caught a flaky test. `watch.test.ts`, "imports requested changes once…", read two comments written by one insert in whatever order the database returned them, and they share `created_at` and their UUIDv7 ids aren't monotonic within a millisecond. It now compares them in any order. **Changes to the spec:** §15 (code quality). **Still given up:** the owner's review remains the gate for what the warnings list.
- **2026-11-09.** Audit fixes on branch `audit-fixes`, from a whole-repo audit. (1) After a database restart, live board updates stopped in every tab: a failed LISTEN left the dead stream's listener behind, and its throw ended the fan-out loop. Now a failed subscribe removes its listener, and a listener that throws is dropped (`lib/events.test.ts`). (2) Moving to Done with an open PR closed the PR before checking for an active run, so a refused move left the PR closed and the confirmed retry logged no `pr_closed`. `run_active` now comes first; `e2e/ship.spec.ts` covers it and failed on the old code. (3) Under `pnpm dev` with no image, project commands and the agent's Bash got `KANBOT_SESSION_SECRET` and `KANBOT_ENCRYPTION_KEY`, enough to sign an owner session. One list (`withoutSecrets` in `commands.ts`) now strips Kanbot's credentials from both. (4) The daily-budget sum on every claim read all of `runs`; it now reads today's rows through a new `runs.ended_at` index (migration 0018). **Changes to the spec:** §12 (move endpoint's 409 order), §14 (stripped env vars).

## What you can do

- **Review and merge on GitHub; Kanbot follows** (phase 5b). After Captain Ship-It opens the PR, the ticket waits in Ship with "CI running" on its card. Every minute Kanbot reads the PR:
  - CI green (or no CI workflows in the repo): the ticket moves to **PR Review**, and **Needs me** lists it as "PR ready for your review".
  - CI red: back to In Progress, with the failing job's log under Artifacts ("CI failed: …"). Sir Codes-a-Lot fixes it, and the ticket goes through Code Review and QA again. It counts as a bounce.
  - You request changes in a GitHub review: your review and its line comments land in the ticket's Comments, and it goes back to In Progress (not counted as a bounce).
  - You approve: the card shows **Approved**. Merge on GitHub, and the ticket moves to Done and Archie writes the retro.
  - You close the PR without merging: the ticket goes back to Backlog; its worktree is removed and the branch kept.
  - You push your own commits to the branch: Kanbot records the new head, and the next agent run starts from it. If Kanbot also has commits you don't, the run stops and asks you to merge them by hand.

- **Add a GitHub repo as a project** (phase 4). On Home, pick the repo under **New project**, give it a key prefix and click **Set up project**. The setup page then walks through:
  1. **Clone.** Kanbot clones the repo; nothing to do.
  2. **Commands.** Check what Kanbot found (install, build, test, lint, start, image, test globs) and confirm.
  3. **Baseline.** Kanbot runs them once on the default branch. Accept the result; anything already failing is skipped by Kanbot's checks from then on.
  4. **CI.** If the repo has no workflow, **Open CI pull request** adds one that runs your commands; merge it on GitHub.
  5. **Branch protection.** **Apply protection** (PR with your approval, green CI, no force-push, for admins too), or **Run agents without it**.
  6. **Ready.** Agents start when you move tickets. Until then the board says "Finish setup".

  A project from a local folder (no GitHub) is still under **Use a local folder instead**.
- **Give a project its env vars** (API keys, connection strings). Onboarding's Commands step lists the names from the repo's `.env.example`; fill in the values, or **Add variable** for others. Change them later under Settings → **Environment variables**.
  - Values are stored encrypted and never shown again ("Set (type to replace)").
  - Every project command gets them: install, the checks, QA's app, and the agents' own runs.
  - For CI, add the same names under the repo's Settings → Secrets and variables → Actions on GitHub. The CI step links there.
  - Use development credentials: code an agent writes can read them.
- **QA needs a start command.** QA runs your app and checks each criterion against it. Without a Start command (Settings), a ticket can't move into QA, and Code Review holds it as "Needs you".
- **Approve and ship.** A ticket that passed QA has an **Approve and ship** button in its drawer. It moves the ticket to Ship, and Captain Ship-It starts (phase 5a).
- **See QA check your pages in a browser** (phase 4b). Nothing to set up: when the worker starts the QA app, Testy can open it in a headless browser at phone and desktop sizes, click, type and read console errors. Screenshots it takes appear as thumbnails under its test report in the drawer's **Artifacts** tab; click one for full size. If Testy is blocked on a visual criterion, answering "I checked it myself, it's fine" counts as evidence.
- **Ship a ticket** (phase 5a, GitHub projects).
  - In Ship, Captain Ship-It adds a changelog entry, fixes docs the change made wrong and writes the PR description.
  - Then Kanbot runs the checks, pushes the ticket branch and opens the PR, or updates it on a re-ship.
  - The card shows **PR #n** and "PR open · waiting on CI", and the drawer links to the PR on GitHub.
  - Merge it on GitHub. Until phase 5b, drag the ticket on yourself after merging.
  - Agents' commits name the App's bot as author and end with `Kanbot-Agent` and `Kanbot-Ticket` trailers.
  - Dragging a ticket:
    - into Ship before QA passed asks first;
    - into PR Review without a PR offers Ship instead;
    - into Done with the PR still open asks, then closes the PR (the branch stays).
  - A local-folder project has no GitHub, so its Ship column stays a gate.
- **Sign in with GitHub.**
  1. Put `KANBOT_SESSION_SECRET` and `KANBOT_ENCRYPTION_KEY` in `.env` (`openssl rand -base64 32` each) and start `pnpm dev`.
  2. Open `http://localhost:3000` and click **Connect GitHub**.
  3. On GitHub, click **Create**, then pick the repos Kanbot may work on and click **Install**.
  4. Click **Sign in with GitHub**.

  Only the account that created the App can sign in. Every page and API call needs the session; the sign-out button is in the header. **Add repos on GitHub** on Home changes which repos the App can reach.
- **Run Kanbot in WSL**, apart from your Windows files: `docs/deploy.md` setup A. You get a `kanbot` WSL distro with its own rootless Docker, and Kanbot at `http://localhost:3000` in your Windows browser.
- **Run a project's commands in its own image.** In Settings, set **Image** (e.g. `node:22-bookworm`, `python:3.12`, `golang:1.23`). From then on, install, the checks gate (build, lint, test), the QA app and agents' own `{test}`-style commands run in that image, with the worktree mounted. Leave it empty to use what the repo says (below).
- **Nothing to set when the repo says which tools it needs.** On a project's first read, Kanbot looks at the default branch:
  - `.devcontainer/devcontainer.json` that names an `image`: that image;
  - `.devcontainer/devcontainer.json` that builds from a Dockerfile: Kanbot builds that image itself, and rebuilds it only when the files it is built from change on the default branch;
  - else `image:` in `.kanbot/project.yml`;
  - else, when Kanbot runs in Docker, `KANBOT_DEFAULT_IMAGE` (`node:24-bookworm` unless you change it in `.env`);
  - else (development with `pnpm dev`) the host's own toolchain.

  Settings' **Image** is only an override. With a devcontainer Dockerfile, its help says what Kanbot builds when it is empty.

## How to run it

`pnpm db:migrate` (eight new migrations: `0010_project-image`, `0011_project-dockerfile`, `0012_github-app`, `0013_onboarding`, `0014_project_env`, `0015_ticket-pr`, `0016_screenshots`, and 5b's `0017_github_watch`), then `pnpm dev`. Clones go to `KANBOT_REPOS_DIR`, or `.kanbot-repos/` at the repo root when it is unset (`pnpm dev`). Docker must be running for a project with an image. Phase 3 needs two new `.env` variables, `KANBOT_SESSION_SECRET` and `KANBOT_ENCRYPTION_KEY`; without them, every page fails with a message naming the missing one.

## What was built

### Phase 1: project commands in the project's image

- **The setting.** `projects.image` (migration `0010_project-image`), `image` in `projectConfig`, seeded by `projectConfigOf` from the default branch: the devcontainer's `image` first, else `project.yml`'s `image:` (`devcontainer()` in `packages/shared/src/repo.ts`). It is editable on the Settings page, where an empty value clears it. `IMAGE_REF` (`schemas.ts`) refuses anything that isn't a plain image reference, so an image can never be read as a `docker` option.
- **The runner** (`apps/worker/src/commands.ts`, `docker.ts`).
  - `dockerRun()` builds one `docker run --rm --init`: the worktree mounted at the same path as the working directory, a shared `kanbot-cache` volume as `HOME`, no host environment, the `kanbot` label, and for the QA app `PORT` published on 127.0.0.1 only.
  - `runCommand()` (install, the checks gate) uses it when the project has an image. A 10-minute timeout kills the `docker` CLI, not the container, so the container is removed by name afterwards.
  - `startApp()` pulls the image first, so a first download doesn't use up the app's 60 seconds, and `stop()` removes the container. This removes the old `shortcut:` comment.
- **Agents' commands.** The SDK's PreToolUse hook checks every Bash call against the fence as the agent wrote it. Only then, when the call is one of the project's commands (with any arguments), it returns `updatedInput` with the command rewritten into that `docker run` (`containerBash()`), labelled with the run's id. After the run, the worker removes any container with that label still running: the Bash tool's timeout and a cancel both kill the CLI and leave the container behind. git and every other command stay on the host. `RunRequest.bash` carries the rewrite, so the runtime stays unaware of Docker.

### Phase 1b: the devcontainer's Dockerfile, built by Kanbot

- **Detection.** `devcontainer()` (`packages/shared/src/repo.ts`) returns the named image, or the Dockerfile and build context that `build.dockerfile`/`build.context` (or the older top-level `dockerFile`/`context`) point at. Their paths are relative to `.devcontainer/`, so they're made repo-relative, and refused if they leave the repo or are absolute. It is seeded into `projects.dockerfile` (migration `0011_project-dockerfile`). A devcontainer that builds also wins over `project.yml`'s `image:`, as the spec orders them.
- **Build.** `projectImage()` (`apps/worker/src/docker.ts`) runs once per build-column run, before the worktree.
  - With Settings' Image set, it uses that.
  - Otherwise it tags `kanbot-<key>:<tree hash of the build context on the default branch>`. If that tag is missing, it builds it: `git archive <default>:<context>` is piped into `docker build -f <file> -`, two processes with no shell, a 20-minute limit and the `kanbot` label.
  - The resulting tag replaces `config.image` for everything phase 1 runs. A failed build fails the run with the last lines of the build output.
- **Settings.** The Image help names the Dockerfile Kanbot builds when the field is empty.

### Phase 2: deploy files and the nightly cleanup (checked locally)

- **Images.** One root `Dockerfile` with `--target web` and `--target worker` on `node:26-bookworm-slim`.
  - pnpm comes from npm, because Corepack left Node 25+.
  - The web build gets a placeholder `DATABASE_URL`: `next build` loads `lib/db.ts`, which won't load without one, but nothing connects.
  - The worker image adds git and the docker CLI (copied from `docker:29-cli`).
  - Binaries start directly, not through pnpm, which would try to reinstall at start.
  - `.dockerignore` keeps `node_modules`, `.next*`, `.git` and `.env` out.
- **Compose.** `migrate`, `web`, `worker` and `caddy` are under the `app` profile, so `docker compose up -d db` is unchanged for local development.
  - `migrate` runs drizzle-kit once, and web and worker wait for it to finish.
  - The worker uses host networking, because the QA app's container publishes on the host's 127.0.0.1. It mounts the Docker socket (`DOCKER_SOCKET`) and `KANBOT_REPOS_DIR` at the same path, plus a volume for `~/.claude` so agent sessions survive restarts.
  - Each service gets only the variables it lists. The worker gets `DATABASE_URL`, `ANTHROPIC_API_KEY` and `KANBOT_RUNTIME`, never the whole `.env`.
  - `KANBOT_DB_PORT` lets a second stack run beside the dev database.
- **Caddy.** `Caddyfile` reverse-proxies `{$KANBOT_DOMAIN}` to `web:3000` with `flush_interval -1`, so SSE isn't buffered.
- **Deploys.** `.github/workflows/deploy.yml` runs after CI passes on main: SSH with a pinned host key, check out that commit, then `docker compose --profile app up -d --build`. It is off until the repo variable `KANBOT_DEPLOY` is `on`. CI gained an `images` job that builds both images.
- **Nightly cleanup** (`apps/worker/src/cleanup.ts`), a minute after the worker starts and then every 24 hours:
  - `run_events` past 90 days, keeping each ticket's last run;
  - worktrees that Done tickets still hold (the branch stays);
  - `docker image prune` of `kanbot`-labelled images unused for 7 days.
- **Worker lock.** If the worker loses its single-worker lock connection, it now exits and compose restarts it. Before, it logged a warning and kept running without the lock; that `shortcut:` was marked "revisit with deployment".
- **`docs/deploy.md`**, for the owner, step by step: Droplet and block storage, firewall, DNS, the `kanbot` user, rootless Docker (data-root on the volume, unprivileged ports from 80), the clone, the server `.env`, starting the stack (only after phase 3), turning on the deploy workflow, nightly `pg_dump` to Spaces, and housekeeping.

### Phase 2b: Kanbot in WSL, and a default image

- **Default image.** `projectImage()` falls back to `KANBOT_DEFAULT_IMAGE`, which `docker-compose.yml` sets for the worker (`node:24-bookworm`), and refuses a value that isn't an image reference. Without it, a project with no image ran its install and tests in the worker's own container, next to the Docker socket. `pnpm dev` leaves it unset, so development and tests still use the host toolchain.
- **Images are pulled before the run's first command** (`pullImage()`, also used by `startApp()`). A failed download now fails the run. Before, it showed up as the checks gate's `node --test` failing, which bounced the ticket back to Sir Codes-a-Lot; with a real agent that is a paid run for nothing. Found by the WSL check ("failed to commit snapshot … lease does not exist" from Docker on a first pull).
- **Compose profiles.** `app` is now migrate, web and worker; Caddy has its own `public` profile. The machine's `.env` sets `COMPOSE_PROFILES` (`app` in WSL, `app,public` on a server), so the commands are just `docker compose up -d --build`, and the deploy workflow no longer names a profile. The web app is published on `127.0.0.1:${KANBOT_WEB_PORT:-3000}`.
- **The web container reads the repos.** It mounts `KANBOT_REPOS_DIR` read-only at the same path, and git moved into the shared base image: the web app checks a new project's repo path and serves the Diff tab with git. It runs as `node` while the repos belong to the worker's user, so compose sets `safe.directory=*` for its git through `GIT_CONFIG_*` variables. Found by the WSL check: adding a project with a repo failed with "Repo path must be an absolute path to an existing folder".
- **Deleted tickets' worktrees.** Deleting a ticket removes its worktree from the web app, which can't write to a read-only mount. The nightly cleanup now also removes worktree folders whose name is no ticket's key. This also covers the old `shortcut:` about a cancelled agent still holding the folder.
- **`docs/deploy.md`** is now "Running Kanbot": setup A (a WSL distro named `kanbot`, with Windows drives and interop turned off in `/etc/wsl.conf`, kept running by a logon task) and setup B (any Ubuntu server; DigitalOcean as the example). The `kanbot` user, rootless Docker, the clone and the `.env` are shared.

### Phase 3: the GitHub App, Sign in with GitHub, auth on every route

- **Credentials.** `packages/shared/src/github.ts` (server-only, `@kanbot/shared/github`) handles them.
  - `encrypt`/`decrypt` use AES-256-GCM under `KANBOT_ENCRYPTION_KEY`, and a tampered value or another key throws.
  - `saveGitHubApp` writes `settings.github_app` (migration `0012_github-app`) only while it is null.
  - `loadGitHubApp` reads it back.
  - The worker will use the same module for installation tokens in phase 5.
- **Setup.**
  - `GET /api/github/setup` answers with a self-submitting form that POSTs the manifest to `github.com/settings/apps/new`. The manifest holds the §10 permissions, the callback and redirect URLs and `setup_url`. It has no webhook: GitHub refuses a localhost hook URL even when inactive (found on the owner's first real try).
  - `GET /api/github/callback` checks the state, exchanges the code (`/app-manifests/{code}/conversions`), saves the App with its owner and sends the owner to the App's install page.
  - Once an App exists, setup redirects to `/login`.
- **Sign in.**
  - `/api/auth/login` sends the owner to GitHub's OAuth page.
  - `/api/auth/callback` checks the state, exchanges the code and reads `GET /user`. Only the App owner's id gets a session; anyone else lands on `/login?error=not_owner`.
  - `POST /api/auth/logout` clears the cookie.
- **The session** (`apps/web/lib/auth.ts`) is `base64url({uid, exp}).HMAC-SHA256`, 30 days, HTTP-only, `SameSite=Lax`, and `Secure` off this machine. It is compared in constant time.
- **`proxy.ts`** keeps its localhost and same-origin rules first, then requires the session on everything except `/login`, `/api/auth/*`, the two setup routes and `/_next/`. `/api/*` gets 401 `unauthorized`; pages redirect to `/login`.
- **UI.**
  - `/login` shows Connect GitHub before an App exists, and Sign in after, with the owner's login and a message for each error.
  - Home and the board get a sign-out button.
  - Home gets **Add repos on GitHub**. It went on Home rather than Settings, because the App is global and Settings is per project.
- **Tests.**
  - `playwright.config.ts` sets test secrets.
  - `e2e/global-setup.ts` stores a fake App and saves a signed session as the specs' `storageState`.
  - `e2e/auth.spec.ts` covers the rest: 401 without a cookie, 401 with a forged one, a page redirecting to `/login` with Sign in, setup refusing a second App, and a callback with the wrong state refused.

### Phase 5b: watching GitHub

- **Rules.** `GITHUB_RULES` and `afterGitHub()` in `transitions.ts`: `ci_passed` Ship → PR Review; `ci_failed` Ship or PR Review → In Progress (bounce); `changes_requested` PR Review → In Progress (no bounce); `merged` → Done; `closed` → Backlog. The bounce limit sends a CI bounce to Blocked.
- **GitHub calls** in `@kanbot/shared/github`: `checkRuns()`, `ciOf()` (any failed check fails, all completed passes, else pending), `workflowFiles()` (moved from the web app's onboarding), `jobLogTail()` (the last 150 lines of an Actions job's log; fetch drops the token on GitHub's redirect to storage), `listReviews()`, `reviewComments()`.
- **The watcher**, `apps/worker/src/watch.ts`, every 60 s from `main.ts` (and once at start):
  - It reads each ticket in PR Review, or in Ship flagged `pr_open`, on a cloned GitHub project; one installation token per project per tick.
  - `look()` reads the PR, its head's check runs (and the branch's workflow files when there are none), and its reviews, outside any transaction.
  - `apply()` re-reads the ticket `FOR UPDATE`, skips it if it changed, then writes `head_sha`, `ci_state`, `review_state` and `last_review_id`, the activity rows (actor `GitHub`), the imported comments, the "CI failed" test report (redacted with the project's env values), and the move through `moveAndStart()`, which `finish()` now shares. Entering PR Review sends a `pr_review` notification. A closed PR's worktree is removed after the transaction.
- **FR-48.** `pullBranch()` in `ship.ts`: before a run on a ticket with a PR, fetch the branch with the App's token and fast-forward the worktree; a diverged branch fails the run with a message. Ship's push now resets `ci_state` to `pending`.
- **UI.**
  - `components/pr-status.tsx`: "CI running/passed/failed" and "Approved"/"Changes requested" badges, on the card next to "PR #n" and in the drawer's header.
  - PR Review tickets are in **Needs me** as "PR ready for your review".
  - The timeline words the new actions: opened/updated, merged and closed PRs, CI changes, imported reviews and outside pushes.
- **Data.** Migration `0017_github_watch`: enums `ci_state` and `review_state`, the three ticket columns, four activity actions.
- **Tests.**
  - Unit: `afterGitHub` (4 tests).
  - Worker: `watch.test.ts` (10 tests) ships a real branch through the stub, then covers CI pending → green, no workflows, red with the log, the bounce limit, requested changes imported once, approval, merge (Archie queued), close (worktree gone, branch kept), a ticket the owner moved mid-tick, and the owner's push fast-forwarded into the next Ship. The stub now serves PR heads (read from the origin repo), check runs, reviews, review comments and job logs, with setters.
  - e2e: `ship.spec.ts` checks the CI and review badges and the Needs me entry.

### Phase 5a: Captain Ship-It opens the PR

- **The agent.** `agents/captain-ship-it.md` (Sonnet 5.5, $0.50, 10 minutes).
  - Tools: Read, Grep, Glob, Edit, Write and local git.
  - A new `editScope: docs` allows Markdown files and `docs/` only, so the post-run check fails a run that touches code.
  - It reports a `pr_description` artifact (a new artifact kind).
  - Ship's context bundle has the same branch sections as review and QA, with its own task line.
- **The worker** (`apps/worker/src/run.ts`, `ship.ts`).
  - Ship is a worktree column now.
  - After a successful Ship run, the checks gate runs again (it covers "re-runs tests"). A failure bounces to In Progress like the gate's (new `RUN_RULES` row).
  - `pushAndOpenPr()` pushes `HEAD` to the `kanbot/…` branch, with the installation token in git's environment (`gitAuth()`, now shared with onboarding's clone). The push is never forced.
  - It then opens the PR (`POST /pulls`), or updates the title and body when the ticket already has one (`PATCH`). The body is Ship-It's description, plus a footer naming the ticket.
  - `finish()` stores `pr_number`, `pr_url` and `head_sha` (migration `0015_ticket-pr`) and logs `pr_opened`. The ticket stays in Ship, flagged `pr_open`.
  - A push or GitHub error fails the run with the message, and Retry works.
  - `startColumnAgent` keeps Ship a gate on a project without GitHub.
- **Trailers and identity (FR-42).** `commitAs()` (`commands.ts`) rewrites an agent's `git commit` in the PreToolUse hook, after the fence has checked the original command.
  - It adds the `--trailer` lines right after `commit`.
  - On a GitHub project it also adds `-c user.name/email` for `<slug>[bot]`, with GitHub's noreply address (`botIdentity()`, one `GET /users` per process).
  - It composes with the container rewrite.
- **Web.**
  - `moveTicket()` returns three new 409s:
    - `skip_gates`: into Ship, unless the ticket comes from QA flagged `awaiting_approval` or from PR Review;
    - `no_pr`: into PR Review with no PR;
    - `pr_open`: into Done with an open PR.
  - The flags are `confirmSkip` and `confirmClose`. Closing reads the PR, closes it before the move's transaction and logs `pr_closed`.
  - The board answers each with a confirm; `no_pr` offers to move the ticket to Ship instead.
  - Cards show a PR chip and a "PR open · waiting on CI" pill. The drawer links to the PR.
- **Tests.**
  - The stub gained PR numbers, `GET` and `PATCH` on a PR, and `GET /users`.
  - `ship.test.ts`: a PR opened with the description, its fields stored and the branch on the origin; a re-ship updating the same PR; a refused push; edits outside docs refused; a local project's Ship as a gate; the trailer rewrite, also run through a real shell and `git log`.
  - `transitions.test`: the Ship rows.
  - `e2e/ship.spec.ts`: the three confirmations, the chip, the pill and the drawer link, and the PR closed on the stub.
  - Replay fixtures `captain-ship-it/{default,reship,edits-code,no-report}.json`.

### After phase 4: project env vars

- **Storage.** `projects.env` (migration `0014_project_env`): encrypted JSON `{NAME: value}`, using `encryptEnv`/`decryptEnv` beside the App's `encrypt`/`decrypt` in `github.ts`. An empty value means the name is known but not set.
- **API.** `patchProjectBody.env` replaces the whole set, with null keeping a stored value. Names are validated, `PORT`/`HOME`/`PATH` are refused, and values may not contain newlines. Project and onboarding reads return `env: [{name, set}]` (`envView()` in `lib/projects.ts`).
- **Detection.** At clone, `envNames()` reads `.env.example` (or `.sample`, `.template`), and the names are stored with empty values. Values already set (a retry) stay.
- **Worker.**
  - `openEnv()` (`commands.ts`) writes a 0600 env file to a fresh temp folder and gives back a dispose function. `runCommand`, `install`/`ensureWorktree`, `runChecks`, `runBaseline`, `startApp` and `containerBash` take it: `--env-file` in docker, merged into the environment on the host.
  - `redactText()` also takes the project's values, raw and JSON-escaped. It covers run events, recordings, run errors, checks reports and baseline output.
- **CI.** `starterWorkflow()` adds a job `env` from `secrets.NAME`. The CI step and the PR body name the secrets to add on GitHub.
- **UI.** `components/env-editor.tsx` is used in the setup wizard's commands step and on Settings. Each row has a name, a password input that reads "Set (type to replace)" or "Not set", and a remove button, plus an **Add variable** button.

### Phase 4: onboarding

- **State.** `projects` gains `github_owner`, `github_repo`, `onboarding` (step and state) and `baseline` (migration `0013_onboarding`). The steps are `clone`, `commands`, `baseline`, `ci`, `protection` and `ready`. The worker runs `clone` and `baseline` while they're `queued`; every other step waits for the owner. A failed step keeps its error for **Try again**. A new `project.onboarding` event wakes the worker and refreshes the setup page.
- **Shared** (`packages/shared`):
  - `onboarding.ts` (pure) holds the step types, `detect()` (commands, test globs and image from the file list and a few files), `starterWorkflow()`, and the protection rules (`missingRules`, `protectionRules`).
  - `github.ts` gains `gh()` (one REST call; the base URL is `KANBOT_GITHUB_API`), `appJwt()` (RS256 with `node:crypto`), `repoToken()` (an installation token for one repo), `getRepo()` and `listAppRepos()`.
  - `github-stub.ts` is a test-only stand-in for the GitHub calls onboarding makes. Its `clone_url` is a local repo, so tests need no network.
- **Worker** (`apps/worker/src/onboard.ts`).
  - `onboardNext()` claims one queued step. A step a restart interrupted is queued again on start.
  - Clone: the installation token goes through git's environment (`GIT_CONFIG_*`), so it is never saved in `.git/config`. Then `project.yml`/devcontainer first, detection for the rest, saved to the project's settings.
  - Baseline: install, build, lint and test in a throwaway `_baseline` worktree of the default branch (`runBaseline()`), in the project's image.
  - The loop runs beside the run queue on the event and the 5 s poll.
  - `runChecks()` takes the baseline's failed commands and skips them. The context bundle gets a `<baseline_failures>` section, only when there are some, so other projects' prompts are unchanged.
- **Web.**
  - `lib/onboarding.ts` and two routes: `GET /api/github/repos` and `GET/POST /api/projects/:id/onboarding` (one `action` per step).
  - `POST /api/projects` with `githubOwner`/`githubRepo` checks the repo through the App and takes its default branch.
  - The CI PR is written with the contents API on `kanbot/onboarding-ci`, so the web app never needs git. Repeating it updates the file and reuses an open PR.
  - Apply protection leaves a branch that is already protected alone.
- **Gate.** `startColumnAgent` throws `AgentsDisabledError` for a GitHub project whose setup isn't Ready, and the API answers 409 `unprotected`. Local projects (and every older test) are unaffected.
- **UI.** Home's **New project** card is now a repo picker, with the old form in a disclosure. `/p/:id/setup` is a step list with the current step open. The board shows a "Finish setup" banner until Ready.
- **Tests.**
  - Unit: `detect` for Node, Python (NetGPT's shape too), Go and an unknown repo; the workflow; the protection rules; the JWT verified with the public key.
  - Worker: a clone through the stub, then the retry over an existing clone; a baseline with a failing lint, which the checks gate then skips; a failed clone keeping its error; agents refused until Ready.
  - e2e: `onboarding.spec.ts` walks the wizard from the picker to the board. The older specs now open "Use a local folder instead". Global setup starts the stub and stores an App with a real RSA key.

## Key decisions

- **Polling reads each watched PR, its head's check runs and its reviews: three calls per ticket per minute** (phase 5b). With a handful of tickets in Ship and PR Review that's far below the App's 5,000 calls an hour; webhooks replace it with a public server (M6).
- **GitHub's moves are data like the run rules** (`GITHUB_RULES`, `afterGitHub()`), and the watcher reuses `finish()`'s move-and-start (`moveAndStart()`), so a CI bounce resumes Sir Codes-a-Lot's session and the bounce limit sends it to Blocked, like any other bounce.
- **GitHub first, then one transaction that re-checks the ticket.** GitHub is slow, so nothing is locked while it answers; if the owner moved the ticket, Ship ran again or an agent picked it up meanwhile, the tick skips it and the next one sees it fresh.
- **Only Ship (after the push) and PR Review are watched.** That is where §3 has GitHub rows; anywhere else, the ticket is already Kanbot's.
- **Requested changes are imported only from PR Review**, and `last_review_id` marks what's been handled, so a review is never imported twice, and one written while the ticket is still in Ship isn't lost: it is imported once the ticket reaches PR Review.
- **The owner's pushes: fast-forward only** (FR-48). Before each run on a ticket with a PR, the worker fetches the branch and fast-forwards the worktree. A branch that diverged stops the run with a clear message instead of a merge commit or a rebase; rebasing is 5c.
- **Imported review comments are the owner's** (`author_kind` user), so Sir Codes-a-Lot's context already carries them as "owner comments since the last run", with no new prompt section.

- **One `docker run` per command, not a long-lived container per run.** It needs no lifecycle code, and the shared cache volume keeps repeated installs fast. Starting a container adds about a second per command.
- **No image means the host toolchain only in development.** Local development, the sample repo, the tests and the eval keep working without Docker. A containerized worker always uses an image (`KANBOT_DEFAULT_IMAGE` as the last resort), because its own container holds the Docker socket.
- **A dedicated WSL distro, not the owner's existing Ubuntu or Docker Desktop.** Turning off automount and interop means a project container that escapes still can't reach Windows files or run Windows programs. Rootless Docker inside it is the same setup as on a server, so `docs/deploy.md` serves both.
- **Polling, not webhooks, while Kanbot runs locally.** GitHub can't reach a PC behind NAT. A tunnel (Cloudflare Tunnel, Tailscale Funnel) could bring webhooks back without a server; not needed for M5.
- **Plain `docker` CLI, no new dependency.** `execFile` with an argument array, so nothing passes through a shell on the worker side.
- **The fence checks the agent's command, not the rewrite.** The rewritten command contains quotes and paths the fence would refuse; checking first and rewriting second keeps the fence's rules unchanged.
- **The image is read only from the database (seeded from the default branch).** An agent can't change it: `.kanbot/` is off limits by the post-run check, and a devcontainer change on a branch counts only once merged and the project reseeded.
- **Kanbot's own code detects and builds the image, not an agent.** Reading a file and running `docker build` needs no judgment. It's free and predictable, and an agent couldn't be trusted to pick its own sandbox anyway.
- **Only the devcontainer's Dockerfile is built (owner's choice).** A root `Dockerfile` is usually the production image: multi-stage, without dev dependencies or test tools.
- **Built from `git archive` of the default branch, tagged by tree hash.** The checkout's working copy and the worktrees never feed the build, so an agent's branch can't change its tools. The same tree means the same tag, so a build happens once per change, not once per run.
- **The worker runs as root inside its container.** Under rootless Docker that is the host's unprivileged `kanbot` user. Container uid 1000 would map to a subordinate uid and own neither the socket nor the repos. The Agent SDK runs in `dontAsk` mode, not `bypassPermissions`, so it doesn't refuse root.
- **Images are built on the server, not pushed to a registry.** One machine, one owner: a registry would be one more credential and service for nothing.
- **The backup is a host cron job, not a service.** It is one line in `docs/deploy.md`; a container would need the Spaces credentials and a scheduler.
- **No session table (phase 3).** One owner, one cookie: a signed id and an expiry need no storage, and the proxy checks it without a database call. Signing out clears the cookie. A stolen cookie stays valid until it expires (30 days) or the secret changes; fine for a localhost app with one user.
- **The owner is whoever created the App (owner's choice).** GitHub's manifest exchange names that account, so nothing needs configuring, and an App created under a GitHub organization would name the organization; not a case for one person's Kanbot.
- **Plain `fetch` and `node:crypto`, no Octokit or auth library.** Five GitHub calls and an HMAC. Phase 5's installation tokens (an RS256 JWT) are also a few lines of `node:crypto`.
- **URLs from the browser's Host header, not Next's `req.url`.** Next names its bind host, so a visit to `127.0.0.1` came back as `localhost`, and cookies set on one host aren't sent to the other. The proxy has already checked Host, so it is trusted.
- **Onboarding's GitHub calls are the web app's, git is the worker's (phase 4).** The web app's repos mount stays read-only, and the CI PR goes through the contents API. The worker already owns the repos folder and Docker.
- **Detection is Kanbot's code, not an agent's (phase 4).** Reading a lockfile and `package.json` scripts needs no judgment and costs nothing, and the owner confirms the result anyway.
- **Baseline failures are skipped, not compared (owner's choice).** Comparing outputs (which tests failed) would catch more but is fragile and different for every language. The cost is that a new break in an already-failing command isn't caught by the gate; Code Review, QA and CI still see it.
- **The starter workflow runs in the project's image** (`container:`), the same one Kanbot uses, so CI and the checks gate run the same commands in the same toolchain without per-language setup actions.
- **Protection binds admins (owner's choice), and Kanbot doesn't overwrite rules already there.** An owner who protected `main` their own way keeps it.
- **Protection is checked at setup only.** Rechecking before every run would cost a GitHub call per run; removing protection later on GitHub is the owner's own choice. Phase 5 reads PR state from GitHub anyway.
- **Git Bash on Windows** turns the `/c/…` mount path back into `C:/…`, so on Windows the rewritten agent command is prefixed with `MSYS_NO_PATHCONV=1`. Windows is dev only; on Linux the path is unchanged.
- **QA's browser is Kanbot's own tools, not the Playwright plugin** (phase 4b, 2026-11-07). The owner asked for whichever keeps the fence simplest. The plugin is a separate MCP server with about 25 tools, `browser_evaluate` among them: fencing it would take a URL check per tool in the hook, plus trusting its origin flag for whatever a click triggers. Five tools on `playwright-core` fence every request in one place (the browser context's routing), add five schemas to Testy's turns instead of 25, and need no new package version (e2e already locks 1.64.1).
- **Screenshots in Postgres** (bytea), not on disk: the web and worker containers share no screenshot folder, they go with the ticket, and the nightly cleanup of `run_events` doesn't touch them.

## Changes to the spec (`requirements.md`)

- Audit fixes (2026-11-09): §12 `POST /api/tickets/:id/move` answers `run_active` before closing an open PR; §14 agent and host project-command environments lose Kanbot's own credentials.

- Phase 5b (2026-11-07):
  - §10 "CI pipeline": what counts as CI (the head's check runs), and a repo with no workflows goes straight to PR Review (owner's decision). A repo whose workflows never report leaves the ticket in Ship.
  - §3: "PR opened and CI green" also covers no workflows; merged and closed apply from Ship too; a closed PR's worktree is removed. GitHub's rows are `GITHUB_RULES`, and only Ship (after the push) and PR Review are watched.
  - §11: `tickets.ci_state` and `review_state` got their values, plus `last_review_id`; `activity` gained `pr_merged`, `ci_changed`, `review_imported` and `pushed`.
  - §16: the 5b rows are off the M5 table. New rows: the real run on Neural-Noir-Website, and a diverged branch (stops the run until 5c). GitHub health stays for 5c. The stale lines about M5 moving to DigitalOcean now say WSL.

- Phase 5a (owner's choices, 2026-11-07):
  - §4: Ship-It writes, and the worker pushes and opens the PR. Ship-It's tools are docs-only, with no token.
  - §3: Ship's `success` keeps the ticket in Ship, flagged `pr_open`, and a checks failure there bounces. Manual moves gained `skip_gates`, `no_pr` and `pr_open`, and Ship is a gate on a local project.
  - FR-42 and FR-43 are marked built.
  - §10: the Merge button and the "small fix" checkbox moved to M6.
  - §11: `pr_description`, `pr_opened` and `pr_closed`.
  - §12: the move's new flags and 409s.
  - §16: the Ship-It, confirmations and trailers rows came off. The `tickets` row keeps `ci_state` and `review_state`, and a new 5b row covers CI, PR Review and merge detection.
  - "Where things stand".
- Phase 4b, QA's browser (2026-11-07): §4 "How QA runs" (the browser, its fence, screenshots; rendered evidence and the owner's observation), Testy's row; §8 the Playwright plugin is not used (Kanbot's own tools, and why); §11 the `screenshots` table; §16 the Playwright-QA row came off (its leftovers, a Playwright test setup through onboarding and the ready URL/services, stay as one row) and Playwright left the plugins row; §17 "QA" and "Plugins"; "Where things stand".
- §4 "How QA runs" (2026-11-07): the app may listen on any port and host; a forwarder container finds the port and relays to it. The start command may say `$PORT`. New pinned image: `alpine/socat:1.8.0.3`.

- §7 "Project toolchains": how commands run (one `docker run` each, mount, cache, label, cleanup), the agent Bash rewrite, rootless Docker with the plain CLI instead of a socket proxy, git not available inside the container, how the image is found (devcontainer image or Dockerfile build, then `project.yml`), the build from the default branch, and the root `Dockerfile` ignored.
- §4 "How QA runs": the app runs in the image, published on 127.0.0.1, and must listen on all interfaces inside the container.
- §7 "Deployment": the containers (with `migrate` and the `app` profile), isolation under rootless Docker (the worker is container root), backups as a host cron job, the nightly cleanup, and deploys built on the server after CI. The "Still to build" row for compose and Dockerfiles became "the real deployment on the Droplet" (in 2b: "Running Kanbot in its own WSL distro", with the public server on the M6 table). A row was added for the disk-over-90% guard (§8), which was never built and was found missing while reading §8 for the cleanup.
- Phase 2b, §7 "Deployment": two setups (WSL now, a server later and optional), the `app`/`public` profiles and `COMPOSE_PROFILES`, the web app on 127.0.0.1, `KANBOT_DEFAULT_IMAGE` in the image order, backups and deploys for both setups. §10 "Events": polling is the only path in WSL. §1 non-goals, §15 portability and security, the tech-stack table, "Hosting" in §17 and "Where things stand" no longer say Droplet.
- §9 and §11: `image` is a project setting; `image` and `dockerfile` are `projects` columns. §14: project commands run in the image when the project has one.
- Phase 3:
  - §10 "Two-click setup": what's stored and where, the owner as the App's creator, the Add repos link on Home (not Settings), one App per Kanbot, localhost-only setup, no webhook while local, and an App tied to the address it was created from.
  - §11: `settings.github_app`.
  - §12: auth on every route as built (cookie, proxy, 401 and redirect, state), and the GitHub endpoints marked built.
  - §16: the auth row came off, and the GitHub App row is now onboarding only. The M6 public-server row lists what a domain needs: the proxy, `X-Forwarded-Proto`, the webhook, and setup over an SSH tunnel.
  - "Where things stand": login and the App.
  - §10: no webhook in the manifest while local (GitHub refuses a localhost hook URL).
- "Where things stand" and §10 updated; the phase-1 row came off "Still to build". Onboarding steps 8–9 went onto the M6 table.
- Phase 4:
  - §10 "Onboarding a repo": built details for each step (where it runs, the clone's token, detection by language, the baseline and the checks gate, the starter workflow in the project's image, the protection rules with `enforce_admins` and the 403 case, agents gated until Ready).
  - §8 checks gate: skips commands that failed at baseline. §4: onboarding proposes the start command; the ready URL and services still aren't detected.
  - §11: `projects.onboarding`, and `baseline` per command.
  - §12: `/api/github/repos`, `/api/projects/:id/onboarding`, the GitHub body of `POST /api/projects`, the move's 409 `unprotected`, and the `project.onboarding` event.
  - §13: the wizard is built. §16: the onboarding row and the `projects` GitHub row came off. "Where things stand" lists onboarding.
- After phase 4 (owner's choice, 2026-11-07): QA needs a start command.
  - §4 "How QA runs": code is evidence only for criteria about the code. Without a start command, a move into QA is refused.
  - §3: a new Code Review row (held when there's no start command), and QA's approval can also be "Approve and ship".
  - §10 step 4: confirming needs a start command.
  - §12: `approve-ship`, 409 `qa_setup` on move and `confirm-commands`.
  - §16: desktop apps can't be driven yet, so their QA can't pass.
- Project env vars (owner's choices, 2026-11-07):
  - §10: step 4 proposes env var names; a new "Environment variables" built detail covers storage, who gets them, the env file, redaction and the limit; step 6's workflow reads them from Actions secrets.
  - §7: `docker run` passes only the project's env vars, by `--env-file`.
  - §11: `projects.env`.
  - §12: `env` on project GET/PATCH.
  - §14: the env-var bullet and its limit.
- §8 and the Code quality row (§15): CI enforces the eval rule and fails PRs that weaken the checks, with owner-only override labels; tests can't reach real services; e2e runs a production build in CI.

## Checks run

- Phase 5b (2026-11-07):
  - `pnpm typecheck` and `pnpm lint` are clean. 64 shared and 152 worker tests pass, including `afterGitHub` (4) and `watch.test.ts` (10).
  - All 17 e2e specs pass; `ship.spec.ts` now checks the CI and review badges and the Needs me entry.
  - Browser check (throwaway script, own port 3201 and database `kanbot_check5b`, replay worker, the GitHub stub in-process, watcher ticks called directly), passed. Screenshots in `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\6f709741-eef5-41a3-9335-ad25a11d858a\scratchpad\shots5b\`:
    - `02-ship-card`: "PR open · waiting on CI", "CI running";
    - `04-pr-review-card`, `05-needs-me-pr-ready`: CI passed in PR Review, and "PR ready for your review" in Needs me;
    - `06-drawer-approved`, `07-done-timeline`: Approved, then merged → Done with Archie's retro, every step in the timeline as `GitHub`;
    - `08-drawer-ci-failed`: the "CI failed: test" report with the job log, In Progress, 1 bounce;
    - `11-drawer-changes-requested`, `12-drawer-changes-timeline`: the review and its line comment imported, back to In Progress, the ticket's whole loop (CI fail → build loop → reship → CI pass → changes requested) in the timeline;
    - `13-board-dark`: the badges in dark mode.
  - Not checked: real GitHub (the real run on Neural-Noir-Website), a phone-width board, and a CI app other than Actions.

- Phase 5a:
  - `pnpm typecheck` and `pnpm lint` are clean. 59 shared and 129 worker tests pass, including the 7 in `ship.test.ts`.
  - All 16 e2e specs pass, including `ship.spec.ts`.
  - Browser check: a throwaway Playwright spec against the e2e stack (dev server, replay worker, GitHub stub), in light and dark, deleted afterwards. All of these passed:
    - Backlog → Ship asks "Code Review and QA haven't passed. Ship it anyway?";
    - → PR Review without a PR offers Ship;
    - the card's chip and pill, and the drawer's PR link;
    - → Done with the PR open asks, then closes it on the stub;
    - no page-level horizontal scroll at 390 px.

    The first tries found problems only in the check itself: a GitHub project with no repo really ran Ship-It and failed, and the shared stub remembered the PR the first theme closed. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\ad21bb2a-5e73-4aa9-9cf1-ae2f423d8942\scratchpad\p5a\{0-local-gates,1-board,2-drawer,3-done}-{light,dark}.png` and `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\ad21bb2a-5e73-4aa9-9cf1-ae2f423d8942\scratchpad\p5a\4-phone-light.png`.
  - Not checked yet: `pnpm eval:agents` with Ship-It (paid), a real push and PR on GitHub, and a real agent's commit going through the trailer rewrite inside the SDK.

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: 34 shared + 110 worker tests pass. The new Docker-backed tests ran for real (Docker Desktop 29.9.2, `node:24-alpine`): the checks gate's failing `node --test` output came from the container; the QA app answered from a container on 127.0.0.1; no `kanbot`-labelled container was left afterwards. Pure tests cover `dockerRun`, `containerBash`, `shQuote` and the devcontainer image reader (now `devcontainer()`).
- The rewritten agent command run through Git Bash ran the sample repo's tests in the container (6 pass), after adding `MSYS_NO_PATHCONV=1`, which this check found missing.
- `pnpm test:e2e`: 12 pass, including the Settings API test extended for `image` (set, refused as a flag, kept across a partial patch, cleared).
- Browser check (`next build` + `next start` on :3200 against `kanbot_test`): the Image field refuses `--privileged` with the message, saves `node:24-alpine` and keeps it after reload, in light and dark. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\a75ec215-2fbc-44de-8cfc-d8138fe11889\scratchpad\settings-{light,dark}-{refused,saved}.png`.
- Phase 1b:
  - `pnpm test`: 35 shared + 111 worker tests pass. A real `docker build` of a committed devcontainer Dockerfile ran in the test. The QA app ran from the built `kanbot-<key>:<hash>` image, and a `COPY` in the Dockerfile took its file from the default branch. A second call gave the same tag without rebuilding, Settings' Image won over the Dockerfile, and a `RUN exit 7` Dockerfile failed with the build output. No labelled containers or images were left afterwards.
  - Pure tests cover `devcontainer()`: image, build with and without context, the older form, and paths outside the repo.
  - `pnpm test:e2e`: 12 pass.
  - Browser check of the Settings help on a project whose repo has a devcontainer build, in light and dark. The first wording contradicted the existing "Empty runs them on the worker's own toolchain" line, so it became one sentence that depends on whether there's a Dockerfile. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\a75ec215-2fbc-44de-8cfc-d8138fe11889\scratchpad\dockerfile-{light,dark}-empty.png`.
- Phase 2:
  - `pnpm typecheck`, `pnpm lint`, `docker compose config` (with and without `--profile app`): clean. The new cleanup test passes: an old run's events are pruned, the ticket's last run is kept, and a Done ticket's worktree is removed with its branch kept.
  - Both images built on Docker Desktop. The check stack `docker compose -p kanbotcheck --profile app up -d db migrate web worker` (database on :5433, `KANBOT_RUNTIME=replay`) checked:
    - `migrate` exited 0;
    - web was ready;
    - the worker came up and reached Postgres over host networking;
    - a script inside the web container created a project and ticket and moved it to Planning; the worker container ran Plan B's replay and the ticket got "Plan ready";
    - from inside the worker (as container root, after the switch from uid 1000), `docker run` started a project container, and a container publishing `127.0.0.1:4555` answered the worker's `fetch`, which is the QA app's path;
    - the nightly cleanup logged its first run after 60 s, and the image prune raised no warning.

    The stack and its images were removed afterwards.
  - `caddy validate` on the Caddyfile: valid. Caddy itself was not started locally (see the progress log).
- Phase 2b:
  - `pnpm typecheck`, `pnpm lint`: clean. `pnpm test`: 35 shared + 113 worker tests pass. New: `projectImage()` falls back to `KANBOT_DEFAULT_IMAGE` and refuses `--privileged`; the cleanup test also removes a worktree whose ticket doesn't exist.
  - `docker compose config --services`: only `db` without profiles; db, migrate, web, worker and caddy with `COMPOSE_PROFILES=app,public`.
  - **The stack in WSL.** In the owner's Ubuntu 24.04 WSL, on its own Docker Engine 29.9 (rootful there; the dedicated distro will be rootless), a fresh clone ran `docker compose up -d --build` with `COMPOSE_PROFILES=app`, the replay runtime, and ports 5434/3200 (5432 was taken). Checked:
    - `/api/health` from Windows at `http://localhost:3200`: database ok, worker ok (WSL forwards the loopback port);
    - a script in the worker container made a sample repo under the repos folder, created a project with that repo (through the web container) and a ticket, and moved it to In Progress. Sir Codes-a-Lot's run, the checks gate (`node --test`), Nitpick Nancy and Testy (with the QA app) ran, and the ticket stopped at QA, awaiting approval. `docker events` showed both project containers started from `node:24-bookworm`, the default image;
    - the Diff endpoint answered from the web container, so git works over the read-only mount;
    - the first try found the three bugs listed in the progress log. The worker's start time showed the distro had been stopped while idle and Docker brought the stack back, which is why `docs/deploy.md` adds the logon task.

    The check stack, its images, volumes and folder were removed afterwards; the Ubuntu distro's earlier containers and images were left alone.
- Phase 3:
  - `pnpm typecheck`, `pnpm lint`: clean.
  - `pnpm test`: 38 shared + 113 worker tests pass. New: encrypt and decrypt round-trip with a fresh IV each time, and a tampered value, another key and a short key are refused.
  - `pnpm test:e2e`: 14 pass, including the two new auth specs. Every older spec now runs signed in.
  - Browser check (`next dev` on :3200 against a fresh database, Playwright), 19 checks pass:
    - signed out, `/` redirects to `/login` with Connect GitHub;
    - Connect GitHub POSTs the manifest to github.com with the right callback and redirect URLs and `administration: write`, and sets an HTTP-only state cookie;
    - with an App stored and a signed cookie, Home shows Add repos on GitHub with the right link, and the board shows the sign-out button;
    - Sign out clears the cookie and stays on `127.0.0.1`; the board then redirects to `/login`, which shows Sign in.

    Both themes were checked. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\68abe618-96fd-4c6e-98c8-3363c11aaf1b\scratchpad\p3-{connect,home,board,signin}-{light,dark}.png` and `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\68abe618-96fd-4c6e-98c8-3363c11aaf1b\scratchpad\p3-github-manifest.png`.
  - **The real round trip** (owner, `pnpm dev` on localhost:3000): Connect GitHub, Create, Install on `MatthewOsorio/NetGPT` only, Sign in. The first try found GitHub refusing the localhost webhook (fixed: no webhook in the manifest). Afterwards a read-only script checked:
    - `settings.github_app` is encrypted, and holds App `kanbot-6527ff` (id 5660007), owner MatthewOsorio, a private key and a client secret;
    - with an App JWT signed from that key, GitHub's `GET /app` shows exactly the §10 permissions and no events;
    - one installation (selected repos), whose installation token lists `MatthewOsorio/NetGPT` (default branch `main`);
    - the server log shows the setup, the manifest callback and the OAuth callback all ending in redirects, with no errors.
  - Not checked: a second GitHub account being refused (the owner has none at hand). The `user.id !== ownerId` check is one line.
- Phase 4:
  - `pnpm typecheck`, `pnpm lint`: clean.
  - `pnpm test`: 51 shared + 117 worker tests pass. New: `detect`, `starterWorkflow`, `missingRules`, `baselineFailures`, the App JWT checked against the public key, and the worker onboarding tests listed under "What was built".
  - `pnpm test:e2e`: 15 pass, including `onboarding.spec.ts`, which walks from the repo picker through clone, commands, baseline, the CI PR and protection to the board, against the stub.
  - Browser check (`next dev` on :3200, its own database `kanbot_check`, the stub posing as `MatthewOsorio/NetGPT` with the sample repo, a replay worker), 9 checks pass:
    - Home lists the App's repos;
    - the clone finishes and the commands are proposed;
    - the baseline shows a passing and a failing command, with output;
    - the board shows Finish setup during setup and not after;
    - the CI step offers the starter PR, and the protection step lists what `main` lacks, with the PR link;
    - Ready;
    - no horizontal scroll at 390 px.

    Both themes were checked. The first run found the clone retry bug (progress log) and the baseline listed in jsonb's key order; both fixed. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\e9849090-3633-4802-8dd0-48affe014f43\scratchpad\p4-{home,commands,baseline,board-banner,ci,protection,ready,ready-phone}-{light,dark}.png`.
  - Not checked yet: the real run on NetGPT (GitHub's real API, a real clone, the Python image, the CI PR and protection on GitHub).
- After phase 4 (QA needs a start command, Approve and ship): typecheck and lint clean; 52 shared and 117 worker tests (new: `qaRunnable`, a reviewed ticket held in Code Review with a move into QA refused; the "no app configured" context test went, as a move can't reach it now); 15 e2e specs (onboarding refuses commands with no start; "Approve and ship" moves a QA-passed ticket to Ship).
- Not checked: a real agent's Bash call going through the rewrite inside the SDK. It would need a paid run; the hook is a few lines, and the rewritten command itself was run through a shell.
- Project env vars:
  - Typecheck and lint are clean. 56 shared and 121 worker tests pass. New tests:
    - `envNames`, the workflow's `secrets.*` env, and the `env` body's validation;
    - `--env-file` in `dockerRun` and `containerBash`, and the env file's content, mode and removal;
    - redaction, raw and JSON-escaped;
    - a clone proposing `.env.example`'s names, and a baseline whose test passes only with the value and whose printed value is stored as `[redacted]`.
  - All 15 e2e specs pass. `onboarding.spec.ts` now fills `KB_API_KEY` at the commands step, checks the onboarding GET never returns the value, checks the CI step names the secret, and checks Settings shows it as set with an empty input.
  - Browser check: a throwaway spec, screenshots at `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\81921b25-d58c-45c1-aa4a-abf3eba08e10\scratchpad\env-shots\{1-commands-step,2-commands-filled,3-ci-step,4-settings,5-settings-removed}.png`. It covered the detected name with a value, an added `DATABASE_URL`, the CI step's note with the GitHub link, Settings showing set and not-set rows, and remove then save. Light theme only, desktop width.
  - Not checked: a real container run with an env file under Docker (the Docker-backed path is covered by the argument test, not a real `docker run`), and Settings at phone width.
- Phase 4b (QA's browser, 2026-11-07):
  - Typecheck and lint clean. All 141 worker tests pass, including:
    - `browser.test.ts`, real Chromium against a tiny app run by `startApp` in `node:24-alpine`. It opens at 375×812 and 1280×800, checks above and below the fold, types and clicks, catches `console.error`, and saves a screenshot. The refused hosts are an `<img>`, a `fetch`, a WebSocket and a link to another origin on the same machine (the decoy server got zero requests), plus `browser_open` with a URL, `//host` or a bare word.
    - Fence tests: the browser tools pass the hook on QA runs and are refused on runs without an app.
    - A replay run (`qa-browser`) storing two screenshots, with no base64 in the Live log.
  - All 17 e2e specs pass, with the new `qa-browser.spec.ts`: the drawer shows both thumbnails, the PNG loads, and the route serves `image/png`.
  - The worker image built and Chromium launched in it (layer size in "Open items").
  - Browser check (throwaway spec, own port 3300 and database `kanbot_check`, replay worker), all passed, in light and dark: the board, the drawer's Artifacts tab with both thumbnails, the keyboard focus ring, the full-size image in a new tab, the Live tab, and the drawer at 390px. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\0ceebbf4-2eb7-42fc-b07a-4c106fb9374d\scratchpad\check\shots\`.
  - Not checked: a real Testy run (paid, the eval).

## Open items

- Docker Desktop sometimes fails to unpack a first image pull (seen twice now: "lease does not exist", "failed to Lchown"); a retry works. Onboarding shows the error with **Try again**; a run fails with the pull error and Retry works the same way.
- Detection covers Node, Python and Go at the repo root (`shortcut:` comment on `detect()`). Monorepos and other languages get no proposal; the owner types the commands.
- The repo picker shows the first 100 repos per installation (`shortcut:` comment on `listAppRepos()`).
- Python packages from `pip install --user` land in the shared cache volume, so two Python projects share one user site. Fine for one owner; a per-project venv would need a two-step install.
- **To check in the owner's `kanbot` distro** (needs `sudo`, so the owner sets it up from `docs/deploy.md` setup A): rootless Docker's host network and published ports, and a real SDK run as container root (paid; ask first).
- **Moved to M6 with the public server:** Caddy getting its certificate, the deploy workflow end to end, webhooks.
- The logon task that keeps the WSL distro running is documented but untested; WSL's idle shutdown was seen in the check.
- The images are about 2.3 GB each, because they carry the whole workspace's `node_modules`, dev dependencies included. Fine for one machine; trim with `pnpm deploy --prod` if disk or deploy time matters.
- The disk-over-90% guard (§8) was never built. It is now on the M5 "Still to build" list for phase 6.

- The GitHub App knows the address it was created from: one created on `localhost:3000` can't sign in on `127.0.0.1:3000` or another port. A second address needs a callback URL added in the App's settings on GitHub.
- Health still reports GitHub as `unknown`; it comes with phase 5c.
- Phase 5b: a repo whose workflows never report a check on the ticket's branch (e.g. `on: push` limited to `main`) leaves the ticket in Ship; drag it on.
- Phase 5b: the CI log tail comes from GitHub Actions' job log (a check run's id is its job's id). Other CI apps' failures show the check's name and link only.
- A move to Done closes the PR before the move's transaction. If the move then fails (rare: a concurrent change), the PR is closed and the ticket stays where it was.
- The bot identity is looked up once per worker process (`GET /users/<slug>[bot]`), so a renamed App needs a worker restart.
- **The eval doesn't run Ship-It yet.** Its golden tickets use local projects, where Ship stays a gate. Reaching PR Review (§8) needs a stub-backed GitHub project in the eval. Proposed: build it in 5b, together with CI, so one paid run covers both.

- NetGPT is a desktop app, so its QA can't pass until Kanbot can drive desktop apps (or NetGPT has a web UI).
- **Owner's goal (2026-11-07): extend Kanbot to projects other than web apps** (desktop apps, CLIs, libraries). It's a row on the M6 "Still to build" table in `requirements.md` §16.
- Testy's prompt lost its code-read path: `pnpm eval:agents` before merging (paid; owner's OK).
- Settings are seeded once. A repo that adds a devcontainer later needs its Image set in Settings, or a future "re-detect" button.
- Devcontainer `features`, `postCreateCommand` and docker-compose devcontainers aren't applied (`shortcut:` comment on `devcontainer()`).

- **Phase 4b (QA's browser):**
  - `pnpm eval:agents` (owner's OK, 2026-11-08, about $2.66): `bug`, `feature`, `review` and `security` reached QA and ended in Done, within the baseline's bounces. `ui` was blocked by a Kanbot bug, not by Testy: Testy read the heading in the browser after loading, after adding a todo and after ticking one, which is how you check "updates when added or ticked". The stall detector saw the same `browser_read` call 3 times and stopped the run, although every criterion was already marked pass. **Fixed:** a browser click or typing resets the repetition count, like a non-GET `http_request`, and browser calls count as progress (§8; replay test `qa-browser-reads`). Results: `evals/results/2026-11-08T02-23-43-172Z.json`.
  - **Second eval run (owner's OK, 2026-11-08): passes.** All 5 golden tickets reached QA and ended in Done, within the baseline's bounces and cost (about $2.63; `evals/results/2026-11-08T02-51-10-518Z.json`). On `ui`, Testy used the browser: 1 open, 2 types, 3 clicks and 4 reads, with no stall. It took no screenshot, because the criteria were about behavior, not looks. A run in between was invalid and was deleted: I ran e2e at the same time, and e2e's global setup reset the shared `kanbot_test` database mid-eval (about $0.51 wasted). The eval must never run alongside tests.
  - The worker image grows by 390 MB (the headless shell is 273 MB, the rest is its libraries and fonts), from about 2.5 to 2.9 GB. `--with-deps` also installs Xvfb, which pulls in Mesa and LLVM; purging it saves about 200 MB, and the headless shell renders without it (checked in the built image).
  - **Found in the browser check, pre-existing, fixed (owner's OK):** artifact Markdown had no GFM, so the tables Testy's prompt asks for showed as raw `|` text in every test report. Now `remark-gfm` 4.0.1 is on, with table styles in `globals.css` (bordered, a muted header, horizontal scroll when narrow). Checked in the browser in light, dark and at 390px (`3-test-report-{light,dark}.png`, `7-drawer-phone-dark.png` in the check's screenshot folder).
  - Screenshots stay as long as their ticket. A cleanup rule waits until they take real space.
  - Testy can check pages live, but on a project without a Playwright setup it can't commit browser tests (a "Still to build" row).
  - `ship.spec.ts` (5a) raced in the full e2e suite: the move to Done starts Archie, and while the shared replay worker was busy his run was still active, so the next move got 409 `run_active`. The test now passes `confirmCancel` there, as the line after it already did.
- Project env vars can't hold multi-line values (PEM keys), because docker's env file is one line per variable (`shortcut:` comment on the schema). Base64 such a value and decode it in the project for now.
- Kanbot doesn't push env values to GitHub's Actions secrets (owner's choice). The owner adds them by hand, and a value changed in Kanbot must be changed there too.
