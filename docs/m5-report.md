# M5 report: ship and deploy

Status: **in progress (living document, updated as each phase lands).** Branch `m5-ship-and-deploy`, started 2026-11-06.

**Done when:** a ticket goes from Backlog to a human-approved, merged PR.

## Owner decisions at the start (2026-11-06)

- Docker on the Droplet runs **rootless**. The worker uses the plain `docker` CLI against that socket; there is no socket proxy.
- **There is no Droplet or domain yet.** Everything is built and checked locally first: a dev GitHub App on localhost, with polling instead of webhooks. The server setup is written down as steps, and the real deploy is checked once the server exists.
- Onboarding steps 8–9 (Plan B suggests hotspot groups; Kanbot drafts CLAUDE.md and a security note as a PR) **move to M6**.

## Phases

| # | Phase | State |
| --- | --- | --- |
| 1 | Project commands in the project's own image | **done** (2026-11-06), awaiting review |
| 2 | Dockerfiles, compose `web`/`worker`/`caddy`, deploy workflow, nightly cleanup, `docs/deploy.md` | not started |
| 3 | GitHub App two-click setup, Sign in with GitHub, auth on every route | not started |
| 4 | Onboarding (§10 steps 1–7 and 10) | not started |
| 5 | Captain Ship-It, CI status, PR Review gate, merge detection, rebase before runs | not started |
| 6 | Leftovers: `blockWritesOutsideWorkingDirectories`, SDK `sandbox`, SSE `Last-Event-ID` | not started |

## Progress log

- **2026-11-06.** Planned M5 and created this report and the branch.
- **2026-11-06.** Phase 1 done: project commands run in the project's image. Tests, e2e and the Settings browser check pass (see "Checks run"). Stopped for the owner's review before phase 2.

## What you can do

- **Run a project's commands in its own image.** In Settings, set **Image** (e.g. `node:22-bookworm`, `python:3.12`, `golang:1.23`). From then on, install, the checks gate (build, lint, test), the QA app and agents' own `{test}`-style commands run in that image, with the worktree mounted. Leave it empty to keep using the worker's own toolchain, as before.
- **Let the repo name the image.** A repo whose `.devcontainer/devcontainer.json` has an `image` field, or whose `.kanbot/project.yml` has `image:`, seeds it on the project's first read, like the other settings.

## How to run it

`pnpm db:migrate` (one new migration, `0010_project-image`), then `pnpm dev`. Docker must be running for a project with an image. Nothing new to configure.

## What was built

### Phase 1: project commands in the project's image

- **The setting.** `projects.image` (migration `0010_project-image`), `image` in `projectConfig`, seeded by `projectConfigOf` from the default branch: the devcontainer's `image` first, else `project.yml`'s `image:` (`devcontainerImage()` in `packages/shared/src/repo.ts`). It is editable on the Settings page, where an empty value clears it. `IMAGE_REF` (`schemas.ts`) refuses anything that isn't a plain image reference, so an image can never be read as a `docker` option.
- **The runner** (`apps/worker/src/worktree.ts`).
  - `dockerRun()` builds one `docker run --rm --init`: the worktree mounted at the same path as the working directory, a shared `kanbot-cache` volume as `HOME`, no host environment, the `kanbot` label, and for the QA app `PORT` published on 127.0.0.1 only.
  - `runCommand()` (install, the checks gate) uses it when the project has an image. A 10-minute timeout kills the `docker` CLI, not the container, so the container is removed by name afterwards.
  - `startApp()` pulls the image first, so a first download doesn't use up the app's 60 seconds, and `stop()` removes the container. This removes the old `shortcut:` comment.
- **Agents' commands.** The SDK's PreToolUse hook checks every Bash call against the fence as the agent wrote it. Only then, when the call is one of the project's commands (with any arguments), it returns `updatedInput` with the command rewritten into that `docker run` (`containerBash()`), labelled with the run's id. After the run, the worker removes any container with that label still running: the Bash tool's timeout and a cancel both kill the CLI and leave the container behind. git and every other command stay on the host. `RunRequest.bash` carries the rewrite, so the runtime stays unaware of Docker.

## Key decisions

- **One `docker run` per command, not a long-lived container per run.** It needs no lifecycle code, and the shared cache volume keeps repeated installs fast. Starting a container adds about a second per command.
- **No image means the host toolchain.** Local development, the sample repo, the tests and the eval keep working without Docker; the server sets an image per project.
- **Plain `docker` CLI, no new dependency.** `execFile` with an argument array, so nothing passes through a shell on the worker side.
- **The fence checks the agent's command, not the rewrite.** The rewritten command contains quotes and paths the fence would refuse; checking first and rewriting second keeps the fence's rules unchanged.
- **The image is read only from the database (seeded from the default branch).** An agent can't change it: `.kanbot/` is off limits by the post-run check, and a devcontainer change on a branch counts only once merged and the project reseeded.
- **Git Bash on Windows** turns the `/c/…` mount path back into `C:/…`, so on Windows the rewritten agent command is prefixed with `MSYS_NO_PATHCONV=1`. Windows is dev only; on Linux the path is unchanged.

## Changes to the spec (`requirements.md`)

- §7 "Project toolchains": how commands run (one `docker run` each, mount, cache, label, cleanup), the agent Bash rewrite, rootless Docker with the plain CLI instead of a socket proxy, git not available inside the container, devcontainers with `build` not read.
- §4 "How QA runs": the app runs in the image, published on 127.0.0.1, and must listen on all interfaces inside the container.
- §9 and §11: `image` is a project setting and a `projects` column. §14: project commands run in the image when the project has one.
- "Where things stand" and §10 updated; the phase-1 row came off "Still to build". Onboarding steps 8–9 went onto the M6 table.

## Checks run

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: 34 shared + 110 worker tests pass. The new Docker-backed tests ran for real (Docker Desktop 29.9.2, `node:24-alpine`): the checks gate's failing `node --test` output came from the container; the QA app answered from a container on 127.0.0.1; no `kanbot`-labelled container was left afterwards. Pure tests cover `dockerRun`, `containerBash`, `shQuote` and `devcontainerImage`.
- The rewritten agent command run through Git Bash ran the sample repo's tests in the container (6 pass), after adding `MSYS_NO_PATHCONV=1`, which this check found missing.
- `pnpm test:e2e`: 12 pass, including the Settings API test extended for `image` (set, refused as a flag, kept across a partial patch, cleared).
- Browser check (`next build` + `next start` on :3200 against `kanbot_test`): the Image field refuses `--privileged` with the message, saves `node:24-alpine` and keeps it after reload, in light and dark. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\a75ec215-2fbc-44de-8cfc-d8138fe11889\scratchpad\settings-{light,dark}-{refused,saved}.png`.
- Not checked: a real agent's Bash call going through the rewrite inside the SDK. It would need a paid run; the hook is a few lines, and the rewritten command itself was run through a shell.

## Open items

- The real deploy waits for the Droplet and domain.
- Phase 2 must give the containerized worker access to the QA app's port. The app publishes on the host's 127.0.0.1, which a worker in its own container can't reach; the likely answer is host networking for the worker.
- Worktree paths must be the same inside the worker container and on the host, so the bind mounts in `docker run` resolve (repos at `/srv/kanbot/repos` mounted at the same path). Phase 2.
