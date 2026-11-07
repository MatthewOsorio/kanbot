# Kanbot's own images (requirements §7): `--target web` and `--target worker`, built by docker-compose.yml.
# Both carry Node and git; the worker adds the docker CLI only: project commands run in each project's own
# image through the host's (rootless) Docker daemon.
FROM node:26-bookworm-slim AS base
# git for both: web reads diffs and project settings from the repos, the worker makes worktrees.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Corepack no longer ships with Node 25+, so pnpm comes from npm, pinned to package.json's packageManager.
RUN npm install -g pnpm@12.16.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS web
# next build loads route modules, and lib/db.ts insists on a URL; nothing connects at build time.
RUN DATABASE_URL=postgres://build@127.0.0.1/build pnpm --filter @kanbot/web build
# Binaries are started directly: pnpm at run time would re-verify the install, which the non-root user cannot write.
WORKDIR /app/apps/web
USER node
EXPOSE 3000
# 0.0.0.0 inside the container only: compose publishes nothing, Caddy reaches it on the compose network.
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]

FROM base AS worker
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
# Runs as container root: under rootless Docker that is the host's unprivileged `kanbot` user, which owns
# /srv/kanbot and the daemon's socket (docs/deploy.md). Container uid 1000 would map to a subuid instead.
WORKDIR /app/apps/worker
CMD ["node_modules/.bin/tsx", "src/main.ts"]
