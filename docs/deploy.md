# Deploying Kanbot to a DigitalOcean Droplet

How to put Kanbot on one Droplet with Docker Compose and Caddy (requirements §7). It is written for the owner, step by step.

> **Don't expose Kanbot until login exists (M5 phase 3).** Until then the app has no authentication, and it refuses any Host other than `localhost` anyway. You can do steps 1–6 now. Start the stack (step 7) only once Sign in with GitHub has landed.

## What you need

- A DigitalOcean account.
- A domain where you can add a DNS record. Kanbot will live on a subdomain such as `kanbot.example.com`.
- An SSH key on your machine (`ssh-keygen -t ed25519` if you have none).
- Your Anthropic API key for Kanbot's Console workspace (requirements §17).

## 1. Create the Droplet and its storage

1. Create a Droplet:
   - **Ubuntu 24.04 LTS**, at least **2 vCPUs and 4 GB RAM**. 8 GB is safer if two agents will build at once.
   - Add your SSH key. Turn on Droplet backups if you want them.
2. Create a **Block Storage volume** (e.g. 50 GB) in the same region, attach it to the Droplet, and let DigitalOcean format and mount it. Then, over SSH as root, make it `/srv/kanbot`:
   ```sh
   mkdir -p /srv/kanbot
   # DigitalOcean mounts the volume at /mnt/<volume_name>; bind it at /srv/kanbot permanently:
   echo '/mnt/<volume_name> /srv/kanbot none bind 0 0' >> /etc/fstab && mount -a
   ```
   Postgres data, the cloned repos, worktrees and Docker's images and volumes all live here, so they survive a Droplet rebuild.
3. Create a **Cloud Firewall** for the Droplet:
   - inbound **80** and **443** from anywhere;
   - inbound **22** from your own IP only;
   - nothing else. Postgres is never reachable from outside: it binds to 127.0.0.1.

## 2. Point the domain at it

Add an **A record** for `kanbot.example.com` with the Droplet's IP address. Caddy gets the HTTPS certificate on its own once the record resolves.

## 3. The `kanbot` user

Kanbot runs as an unprivileged user, `kanbot`. Rootless Docker runs as this user, and root inside its containers *is* this user on the host. So the worker, the repos, the Docker socket and the files that project containers write all share one owner, and nothing runs as the host's root. As root:

```sh
adduser --disabled-password --gecos "" kanbot
id -u kanbot   # note the uid: the socket path below uses it (1000 on a fresh Droplet)
mkdir -p /srv/kanbot/repos /srv/kanbot/docker /srv/kanbot/backups
chown -R kanbot:kanbot /srv/kanbot
install -d -m 700 -o kanbot -g kanbot /home/kanbot/.ssh
cp ~/.ssh/authorized_keys /home/kanbot/.ssh/ && chown kanbot:kanbot /home/kanbot/.ssh/authorized_keys
loginctl enable-linger kanbot                   # its services keep running when nobody is logged in
```

## 4. Rootless Docker

Docker runs as `kanbot`, not as root (decided 2026-11-06). The worker can then start project containers without holding root on the host. As root, install Docker from Docker's own apt repository (https://docs.docker.com/engine/install/ubuntu/), plus the rootless extras:

```sh
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras uidmap
systemctl disable --now docker.service docker.socket   # no root daemon
rm -f /var/run/docker.sock
# Caddy listens on 80 and 443, which a rootless daemon may only bind with this:
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/90-kanbot.conf && sysctl --system
```

Then, logged in as `kanbot` (`ssh kanbot@<droplet>`, not `su`, so the user's systemd session exists):

```sh
mkdir -p ~/.config/docker
echo '{ "data-root": "/srv/kanbot/docker" }' > ~/.config/docker/daemon.json   # images and volumes on the volume
dockerd-rootless-setuptool.sh install
echo 'export DOCKER_HOST=unix:///run/user/1000/docker.sock' >> ~/.bashrc && . ~/.bashrc
docker run --rm hello-world   # check
```

## 5. Get Kanbot's code

As `kanbot`:

```sh
git clone https://github.com/MatthewOsorio/kanbot.git /srv/kanbot/app
```

If the repository is private, add a read-only **deploy key** first: generate one with `ssh-keygen -t ed25519 -f ~/.ssh/kanbot_deploy` and add the `.pub` under the repo's Settings → Deploy keys. Then clone with the `git@github.com:` URL.

## 6. The server's `.env`

Create `/srv/kanbot/app/.env`, readable only by `kanbot` (`chmod 600 .env`):

```sh
KANBOT_DOMAIN=kanbot.example.com
POSTGRES_PASSWORD=<a long random string: openssl rand -hex 32>
ANTHROPIC_API_KEY=<your key>
DOCKER_SOCKET=/run/user/1000/docker.sock
KANBOT_REPOS_DIR=/srv/kanbot/repos
```

Compose reads this file to fill in `docker-compose.yml`. Each container gets only the variables its service lists, never the whole file. Phase 3 adds the session secret and the encryption key for the GitHub App credentials here.

## 7. Start it (after M5 phase 3)

As `kanbot`, in `/srv/kanbot/app`:

```sh
docker compose --profile app up -d --build
docker compose ps            # db, web, worker and caddy running; migrate exited 0
docker compose logs worker   # "kanbot worker up (runtime: sdk)"
```

Then open `https://kanbot.example.com`.

What runs where:
- `db` is Postgres 16, on 127.0.0.1 only.
- `migrate` applies migrations, then exits.
- `web` is the Next.js app, reached only through Caddy.
- `worker` uses host networking, so it can reach the QA apps that project containers publish on 127.0.0.1. It gets the Docker socket and `/srv/kanbot/repos`, mounted at the same path.
- `caddy` serves HTTPS on 80 and 443.

## 8. Deploys from GitHub

`.github/workflows/deploy.yml` redeploys after CI passes on `main`. It connects over SSH as `kanbot`, checks out the commit, and runs `docker compose --profile app up -d --build`. To turn it on, in the GitHub repo:

1. **Secrets** (Settings → Secrets and variables → Actions):
   - `DEPLOY_HOST`: the Droplet's IP or domain.
   - `DEPLOY_SSH_KEY`: the private half of a new key pair made for this purpose. Add the public half to `/home/kanbot/.ssh/authorized_keys`.
   - `DEPLOY_KNOWN_HOSTS`: the output of `ssh-keyscan <host>`, which pins the server's identity.
2. **Variable** `KANBOT_DEPLOY` = `on`.

## 9. Backups

Postgres is dumped nightly to DigitalOcean Spaces. Create a Spaces bucket and an access key, run `apt-get install -y s3cmd` as root, then `s3cmd --configure` as `kanbot` with the Spaces endpoint (e.g. `nyc3.digitaloceanspaces.com`). Then add to `kanbot`'s crontab (`crontab -e`):

```cron
15 3 * * * cd /srv/kanbot/app && f=/srv/kanbot/backups/kanbot-$(date +\%F).sql.gz && docker compose exec -T db pg_dump -U kanbot kanbot | gzip > $f && s3cmd put -q $f s3://<bucket>/ && find /srv/kanbot/backups -name '*.sql.gz' -mtime +14 -delete
```

To restore: `gunzip -c <file> | docker compose exec -T db psql -U kanbot kanbot` on an empty database.

## Housekeeping

- The worker's **nightly cleanup** runs a minute after it starts and then every 24 hours. It prunes run logs older than 90 days (keeping each ticket's last run), worktrees that Done tickets still hold, and project images Kanbot built that nothing has used for a week.
- The shared package cache volume is not pruned. If it grows too large, stop the worker and run `docker volume rm kanbot-cache`; it fills again on the next installs.
- Updating by hand: `git pull && docker compose --profile app up -d --build`.
