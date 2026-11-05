# M4 handoff (temporary: delete before the final PR)

Branch `m4-unblock-3`, off main after PR #6. Last updated 2026-11-05.

**Status:** P3 and P4 are merged (PR #6). P5 (6c15ebf) and P6 are on `m4-unblock-3`, not pushed; P6 is uncommitted until the owner OKs a commit message. Archie's prompt is approved; Plan B's "Related tickets" section and the golden `reviewComment` have not been run with real agents. The dev DB is migrated through 0007.

**Decisions**
- Costs per ticket: show the total only (drawer and Archie's retro). The $3 per-ticket budget row moves to M6.
- Archie's file is `agents/archie-the-archivist.md`, matching the seeded column slug.
- The golden bounce comes from a late owner comment that `eval.ts` posts when the ticket enters Code Review.

**Next, one commit per phase**
- **P4 ticket links (done):** a `ticket_links` table, `relatedTickets` in the verdict (stored unconfirmed), Nancy's blocking risks proposing `blocks` links, a confirm-links UI, confirmed blockers in the Ready → In Progress overlap check, and overlap pills on cards.
- **P5 project settings (done, 6c15ebf):** `commands`, `test_globs`, `hotspots` and `settings` moved into the DB, seeded once from `.kanbot/project.yml` by `projectConfigOf` (`packages/shared/src/db/ops.ts`). Added `GET/PATCH /api/projects/:id`, the Settings page (`components/settings-form.tsx`), a per-project bounce limit (`afterRun`'s `bounceLimit`) and concurrency (`claimNext` SQL), and the ticket cost total ("Cost so far" in the drawer). For the report's "Changes to the spec": §9 hotspots/commands (DB is the source, the file only seeds), §11 `projects` row, §12 `/api/projects/:id` built, §13 Settings, FR-23 per-project limit, §14 per-ticket budget moved to M6 (a "Still to build" M6 row). Known limits: a hotspot glob can't contain a comma (`shortcut:` comment in `settings-form.tsx`); global concurrency is still the constant `LIMITS.global`; QA settings and the repo path are not editable in Settings yet.
  - Lessons: an empty command from the form must be dropped before storing (`""` fails `projectConfig`'s `min(1)` and breaks every read; found only by the browser check, now an e2e spec). A test that edited `project.yml` to change a command now writes the DB column instead.
- **P6 smaller items (done):**
  - Resume after the bounce limit resets the bounce count.
  - Per-command timeout for agents' shell commands.
  - Reinstall when the lockfile changes.
  - Only the agent's own plugins in its session (or move the row to M5).
  - The top bar's agent notice clears when the run ends.
  - The golden bounce ticket.
  - Built: Resume resets the bounce count at the limit (an `edited` activity, since a new activity enum value would need a migration; e2e in `build-loop.spec.ts`); `BASH_*_TIMEOUT_MS` 10 min in `sdk.ts`; reinstall on lockfile change (marker in the worktree's git dir); the notice now stays until that ticket's `run.finished` (the old 4 s timer is gone; the two agents e2e specs changed to match); `reviewComment` in `eval.ts` and `golden/review.json` (replay shows no bounce; only the real eval can prove it, so check "bounces" for `review` in the final eval before saving the baseline).
  - Only the agent's own plugins: done. Verified with a real session aborted at init: `settings.enabledPlugins` set false for the three `@builtin` ids leaves only `ponytail` in the init plugins (the unset run lists all four). Fixed list in `sdk.ts` (`shortcut:` comment); no unit test, since the options are inline in `query()`.
  - Moved to M5: `blockWritesOutsideWorkingDirectories`.

**Rules**
- Don't push or merge without asking.
- P4 verified: typecheck, lint, `pnpm test`, `pnpm test:e2e` (9 specs, incl. the P3 run), a Playwright UI check with screenshots, and an API smoke test on a throwaway DB with the replay worker. In this WSL sandbox Chromium needs `libnspr4`, `libnss3` and `libasound2` (no sudo: unpack the .debs into a folder and set `LD_LIBRARY_PATH`).
- P5 verified the same way: typecheck, lint, `pnpm test` (shared 32, worker 91 + 1 skipped), `pnpm test:e2e` (10 specs), and a throwaway-DB browser check (Settings seeded, bad command refused, save and reload, drawer cost). The unpacked libraries from an earlier session were at `/tmp/claude-1000/-home-matt-dev-kanbot-kanbot/9759661d-ee79-48f0-9d8a-e35813bc90b8/scratchpad/libs/usr/lib/x86_64-linux-gnu`; `/tmp` may be cleared, so unpack again if it's gone. Without the libraries, the browser-based e2e specs fail at launch (not a code failure).
- When cleaning up after a browser check, stop only the processes you started (by PID or port); never `pkill -f next-server`, which would kill the owner's `pnpm dev`. `psql` isn't installed on the host, but the db runs in Docker: use `docker compose exec -T db psql -U kanbot -d postgres -c 'drop database if exists <name>'` to drop a throwaway database.
- Run `pnpm format` only on files you changed: it also reflows unrelated old lines (revert those).
- After each phase run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:e2e`. 
- Update the spec and the "Still to build" table in the same change as any behavior change.
- Add a test for each new piece of logic.
- Check UI changes in a real browser with screenshots.

**At the end**
1. Ask before `pnpm eval:agents` (about $1.45).
2. Give the owner the manual SDK session-resume check.
3. Write `docs/m4-report.md` using `docs/m3-report.md` as the template, including "Changes to the spec".
4. Update the status lines (CLAUDE.md and "Where things stand").
5. Delete this file, open a draft PR, and stop for review.

The full plan is at `~/.claude/plans/pasted-content-id-0127-continue-m4-warm-hennessy.md`, if it still exists.
