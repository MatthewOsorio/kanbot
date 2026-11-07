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
| 1 | Project commands in the project's own image | **done** (2026-11-06) |
| 1b | Kanbot builds the image from a devcontainer's Dockerfile by itself | **done** (2026-11-06) |
| 2 | Dockerfiles, compose `web`/`worker`/`caddy`, deploy workflow, nightly cleanup, `docs/deploy.md` | **done locally** (2026-11-06); real deploy waits for the Droplet |
| 3 | GitHub App two-click setup, Sign in with GitHub, auth on every route | next |
| 4 | Onboarding (§10 steps 1–7 and 10) | not started |
| 5 | Captain Ship-It, CI status, PR Review gate, merge detection, rebase before runs | not started |
| 6 | Leftovers: `blockWritesOutsideWorkingDirectories`, SDK `sandbox`, SSE `Last-Event-ID`, the disk-over-90% guard | not started |

## Progress log

- **2026-11-06.** Planned M5 and created this report and the branch.
- **2026-11-06.** Phase 1 done: project commands run in the project's image. Tests, e2e and the Settings browser check pass (see "Checks run"). Stopped for the owner's review before phase 2.
- **2026-11-06.** Owner review: the image should come from the repo's Docker files without a trip to Settings. A devcontainer that *names* an image already worked; one that *builds* from a Dockerfile didn't. Decided: phase 1b, where Kanbot builds the devcontainer's Dockerfile itself, from the default branch only. A plain root `Dockerfile` is ignored, because it's usually a production image without test tools. Guessing an image from the language (package.json, go.mod, …) goes with phase 4's command detection. Then phase 2.
- **2026-11-06.** Phase 1b done: a devcontainer that builds from a Dockerfile now gives the project its image with no Settings step. The Settings help text says so. Tests (including a real Docker build), e2e and the browser check pass. Next: phase 2.
- **2026-11-06.** Phase 2 done locally: the deploy files, `docs/deploy.md` (Droplet setup step by step) and the nightly cleanup. A separate check stack (`-p kanbotcheck`, its own database on :5433, replay runtime) ran migrate, web and worker from the new images. Plan B's run went through them, and the worker started a project container and reached its port on 127.0.0.1. Caddy was left out of the local run, because it publishes 80/443 on every interface of the owner's machine; its config was validated on its own. Next: phase 3 (GitHub App and login). The real deploy waits for the Droplet.

## What you can do

- **Run a project's commands in its own image.** In Settings, set **Image** (e.g. `node:22-bookworm`, `python:3.12`, `golang:1.23`). From then on, install, the checks gate (build, lint, test), the QA app and agents' own `{test}`-style commands run in that image, with the worktree mounted. Leave it empty to keep using the worker's own toolchain, as before.
- **Nothing to set when the repo says which tools it needs.** On a project's first read, Kanbot looks at the default branch:
  - `.devcontainer/devcontainer.json` that names an `image`: that image;
  - `.devcontainer/devcontainer.json` that builds from a Dockerfile: Kanbot builds that image itself, and rebuilds it only when the files it is built from change on the default branch;
  - else `image:` in `.kanbot/project.yml`;
  - else nothing: the worker's own toolchain.

  Settings' **Image** is only an override. With a devcontainer Dockerfile, its help says what Kanbot builds when it is empty.

## How to run it

`pnpm db:migrate` (two new migrations, `0010_project-image` and `0011_project-dockerfile`), then `pnpm dev`. Docker must be running for a project with an image. Nothing new to configure.

## What was built

### Phase 1: project commands in the project's image

- **The setting.** `projects.image` (migration `0010_project-image`), `image` in `projectConfig`, seeded by `projectConfigOf` from the default branch: the devcontainer's `image` first, else `project.yml`'s `image:` (`devcontainer()` in `packages/shared/src/repo.ts`). It is editable on the Settings page, where an empty value clears it. `IMAGE_REF` (`schemas.ts`) refuses anything that isn't a plain image reference, so an image can never be read as a `docker` option.
- **The runner** (`apps/worker/src/worktree.ts`).
  - `dockerRun()` builds one `docker run --rm --init`: the worktree mounted at the same path as the working directory, a shared `kanbot-cache` volume as `HOME`, no host environment, the `kanbot` label, and for the QA app `PORT` published on 127.0.0.1 only.
  - `runCommand()` (install, the checks gate) uses it when the project has an image. A 10-minute timeout kills the `docker` CLI, not the container, so the container is removed by name afterwards.
  - `startApp()` pulls the image first, so a first download doesn't use up the app's 60 seconds, and `stop()` removes the container. This removes the old `shortcut:` comment.
- **Agents' commands.** The SDK's PreToolUse hook checks every Bash call against the fence as the agent wrote it. Only then, when the call is one of the project's commands (with any arguments), it returns `updatedInput` with the command rewritten into that `docker run` (`containerBash()`), labelled with the run's id. After the run, the worker removes any container with that label still running: the Bash tool's timeout and a cancel both kill the CLI and leave the container behind. git and every other command stay on the host. `RunRequest.bash` carries the rewrite, so the runtime stays unaware of Docker.

### Phase 1b: the devcontainer's Dockerfile, built by Kanbot

- **Detection.** `devcontainer()` (`packages/shared/src/repo.ts`) returns the named image, or the Dockerfile and build context that `build.dockerfile`/`build.context` (or the older top-level `dockerFile`/`context`) point at. Their paths are relative to `.devcontainer/`, so they're made repo-relative, and refused if they leave the repo or are absolute. It is seeded into `projects.dockerfile` (migration `0011_project-dockerfile`). A devcontainer that builds also wins over `project.yml`'s `image:`, as the spec orders them.
- **Build.** `projectImage()` (`apps/worker/src/worktree.ts`) runs once per build-column run, before the worktree.
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

## Key decisions

- **One `docker run` per command, not a long-lived container per run.** It needs no lifecycle code, and the shared cache volume keeps repeated installs fast. Starting a container adds about a second per command.
- **No image means the host toolchain.** Local development, the sample repo, the tests and the eval keep working without Docker; the server sets an image per project.
- **Plain `docker` CLI, no new dependency.** `execFile` with an argument array, so nothing passes through a shell on the worker side.
- **The fence checks the agent's command, not the rewrite.** The rewritten command contains quotes and paths the fence would refuse; checking first and rewriting second keeps the fence's rules unchanged.
- **The image is read only from the database (seeded from the default branch).** An agent can't change it: `.kanbot/` is off limits by the post-run check, and a devcontainer change on a branch counts only once merged and the project reseeded.
- **Kanbot's own code detects and builds the image, not an agent.** Reading a file and running `docker build` needs no judgment. It's free and predictable, and an agent couldn't be trusted to pick its own sandbox anyway.
- **Only the devcontainer's Dockerfile is built (owner's choice).** A root `Dockerfile` is usually the production image: multi-stage, without dev dependencies or test tools.
- **Built from `git archive` of the default branch, tagged by tree hash.** The checkout's working copy and the worktrees never feed the build, so an agent's branch can't change its tools. The same tree means the same tag, so a build happens once per change, not once per run.
- **The worker runs as root inside its container.** Under rootless Docker that is the host's unprivileged `kanbot` user. Container uid 1000 would map to a subordinate uid and own neither the socket nor the repos. The Agent SDK runs in `dontAsk` mode, not `bypassPermissions`, so it doesn't refuse root.
- **Images are built on the server, not pushed to a registry.** One Droplet, one owner: a registry would be one more credential and service for nothing.
- **The backup is a host cron job, not a service.** It is one line in `docs/deploy.md`; a container would need the Spaces credentials and a scheduler.
- **Git Bash on Windows** turns the `/c/…` mount path back into `C:/…`, so on Windows the rewritten agent command is prefixed with `MSYS_NO_PATHCONV=1`. Windows is dev only; on Linux the path is unchanged.

## Changes to the spec (`requirements.md`)

- §7 "Project toolchains": how commands run (one `docker run` each, mount, cache, label, cleanup), the agent Bash rewrite, rootless Docker with the plain CLI instead of a socket proxy, git not available inside the container, how the image is found (devcontainer image or Dockerfile build, then `project.yml`), the build from the default branch, and the root `Dockerfile` ignored.
- §4 "How QA runs": the app runs in the image, published on 127.0.0.1, and must listen on all interfaces inside the container.
- §7 "Deployment": the containers (with `migrate` and the `app` profile), isolation under rootless Docker (the worker is container root), backups as a host cron job, the nightly cleanup, and deploys built on the server after CI. The "Still to build" row for compose and Dockerfiles became "the real deployment on the Droplet". A row was added for the disk-over-90% guard (§8), which was never built and was found missing while reading §8 for the cleanup.
- §9 and §11: `image` is a project setting; `image` and `dockerfile` are `projects` columns. §14: project commands run in the image when the project has one.
- "Where things stand" and §10 updated; the phase-1 row came off "Still to build". Onboarding steps 8–9 went onto the M6 table.

## Checks run

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: 34 shared + 110 worker tests pass. The new Docker-backed tests ran for real (Docker Desktop 29.9.2, `node:24-alpine`): the checks gate's failing `node --test` output came from the container; the QA app answered from a container on 127.0.0.1; no `kanbot`-labelled container was left afterwards. Pure tests cover `dockerRun`, `containerBash`, `shQuote` and the devcontainer image reader (now `devcontainer()`).
- The rewritten agent command run through Git Bash ran the sample repo's tests in the container (6 pass), after adding `MSYS_NO_PATHCONV=1`, which this check found missing.
- `pnpm test:e2e`: 12 pass, including the Settings API test extended for `image` (set, refused as a flag, kept across a partial patch, cleared).
- Browser check (`next build` + `next start` on :3200 against `kanbot_test`): the Image field refuses `--privileged` with the message, saves `node:24-alpine` and keeps it after reload, in light and dark. Screenshots: `C:\Users\matt\AppData\Local\Temp\claude\ce50016e16918d15\a75ec215-2fbc-44de-8cfc-d8138fe11889\scratchpad\settings-{light,dark}-{refused,saved}.png`.
- Phase 1b:
  - `pnpm test`: 35 shared + 111 worker tests pass. A real `docker build` of a committed devcontainer Dockerfile ran in the test. The QA app ran from the built `kanbot-<key>:<hash>` image, and a `COPY` in the Dockerfile took its file from the default branch. A second call gave the same tag without rebuilding, Settings' Image won over the Dockerfile, and a `RUN exit 7` Dockerfile failed with the build output. No labelled containers or images were left afterwards.
  - Pure tests cover `devcontainer()`: image, build with and without context, the older form, and paths outside the repo.
  - `pnpm test:e2e`: 12 pass.
  - Browser check of the Settings help on a project whose repo has a devcontainer build, in light and dark. The first wording contradicted the existing "Empty runs them on the worker's own toolchain" line, so it became one sentence that depends on whether there's a Dockerfile. Screenshots: `C:UsersmattAppDataLocalTempclaudece50016e16918d15a75ec215-2fbc-44de-8cfc-d8138fe11889scratchpaddockerfile-{light,dark}-empty.png`.
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
- Not checked: a real agent's Bash call going through the rewrite inside the SDK. It would need a paid run; the hook is a few lines, and the rewritten command itself was run through a shell.

## Open items

- **To check on the Droplet** (can't be checked on Docker Desktop):
  - rootless Docker's host network and published ports (the worker reaching the QA app and Postgres on 127.0.0.1);
  - Caddy getting its certificate;
  - the deploy workflow end to end;
  - a real SDK run as container root.
- The images are about 2.3 GB each, because they carry the whole workspace's `node_modules`, dev dependencies included. Fine on one Droplet; trim with `pnpm deploy --prod` if disk or deploy time matters.
- The disk-over-90% guard (§8) was never built. It is now on the M5 "Still to build" list for phase 6.

- Settings are seeded once. A repo that adds a devcontainer later needs its Image set in Settings, or a future "re-detect" button.
- Devcontainer `features`, `postCreateCommand` and docker-compose devcontainers aren't applied (`shortcut:` comment on `devcontainer()`).

- The real deploy waits for the Droplet and domain.
