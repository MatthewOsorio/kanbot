# Running Kanbot

How to run Kanbot with Docker Compose (requirements §7). It is written for the owner, step by step.

Kanbot needs one Linux machine with Docker that stays on while agents work. Two setups are described:

- **A. Your own PC, in WSL** (free; decided 2026-11-06). Kanbot runs in its own WSL distro, apart from your Windows files, and you open it at `http://localhost:3000`. Agents work only while the PC is on. Nothing is reachable from other machines.
- **B. A server** with a domain and HTTPS, so Kanbot works while your PC is off and from anywhere. Any Linux VPS works. The steps use a DigitalOcean Droplet; Oracle Cloud's free tier or any other Ubuntu VPS works the same way (ARM servers too, if each project's image has an ARM version).

Both use the same pieces: a `kanbot` user, **rootless Docker** (root inside Kanbot's containers is that unprivileged user, never the machine's root), the code in `/srv/kanbot/app`, and a `.env`. Only the parts around them differ.

> **Kanbot answers only on `localhost` for now.** Sign in with GitHub exists, but the app still refuses any other Host name, so Caddy on a domain gets 403 until M6 opens the app to it. Setup A is fine as it is. For setup B, don't start Caddy (`COMPOSE_PROFILES=app,public`) yet.

## What you need

- An Anthropic API key for Kanbot's Console workspace (requirements §17).
- For B only: a server, and a domain where you can add a DNS record (Kanbot will live on a subdomain such as `kanbot.example.com`).

## A1. A WSL distro for Kanbot (setup A)

In PowerShell on Windows:

```powershell
wsl --install Ubuntu-24.04 --name kanbot   # when it asks for a user name, enter: kanbot
```

Then, inside it (`wsl -d kanbot`), cut it off from Windows: no Windows drives mounted, no Windows programs callable. Kanbot's containers can then only reach what is inside this distro.

```sh
sudo tee /etc/wsl.conf <<'EOF'
[boot]
systemd=true
[user]
default=kanbot
[automount]
enabled=false
[interop]
enabled=false
appendWindowsPath=false
EOF
```

Back in PowerShell: `wsl --terminate kanbot`, then `wsl -d kanbot` again. `ls /mnt` should now be empty.

WSL stops a distro some time after its last window closes. To keep Kanbot running while you're logged in to Windows, add a Task Scheduler task "At log on" that runs `wsl.exe -d kanbot --exec sleep infinity`, or keep a `wsl -d kanbot` window open.

Then continue with step 3 below, skipping the `adduser` line: the distro's user already is `kanbot`.

## 1. Create the server and its storage (setup B)

1. Create a Droplet (or another VPS):
   - **Ubuntu 24.04 LTS**, at least **2 vCPUs and 4 GB RAM**. 8 GB is safer if two agents will build at once.
   - Add your SSH key (`ssh-keygen -t ed25519` if you have none). Turn on backups if you want them.
2. On DigitalOcean, create a **Block Storage volume** (e.g. 50 GB) in the same region, attach it, and let DigitalOcean format and mount it. Then, over SSH as root, make it `/srv/kanbot`:
   ```sh
   mkdir -p /srv/kanbot
   # DigitalOcean mounts the volume at /mnt/<volume_name>; bind it at /srv/kanbot permanently:
   echo '/mnt/<volume_name> /srv/kanbot none bind 0 0' >> /etc/fstab && mount -a
   ```
   Postgres data, the cloned repos, worktrees and Docker's images and volumes all live here, so they survive a server rebuild. Elsewhere, a large enough root disk is fine.
3. Create a **firewall** for the server (DigitalOcean: a Cloud Firewall):
   - inbound **80** and **443** from anywhere;
   - inbound **22** from your own IP only;
   - nothing else. Postgres and the web app are never reachable from outside: they bind to 127.0.0.1.

## 2. Point the domain at it (setup B)

Add an **A record** for `kanbot.example.com` with the server's IP address. Caddy gets the HTTPS certificate on its own once the record resolves.

## 3. The `kanbot` user

Kanbot runs as an unprivileged user, `kanbot`. Rootless Docker runs as this user, and root inside its containers *is* this user on the machine. So the worker, the repos, the Docker socket and the files that project containers write all share one owner, and nothing runs as the machine's root. As root (`sudo -i`):

```sh
adduser --disabled-password --gecos "" kanbot   # server only; in WSL the user exists already
id -u kanbot   # note the uid: the socket path below uses it (1000 on a fresh machine)
mkdir -p /srv/kanbot/repos /srv/kanbot/docker /srv/kanbot/backups
chown -R kanbot:kanbot /srv/kanbot
loginctl enable-linger kanbot                   # its services keep running when nobody is logged in
```

On a server, also let your SSH key log in as `kanbot`:

```sh
install -d -m 700 -o kanbot -g kanbot /home/kanbot/.ssh
cp ~/.ssh/authorized_keys /home/kanbot/.ssh/ && chown kanbot:kanbot /home/kanbot/.ssh/authorized_keys
```

## 4. Rootless Docker

Docker runs as `kanbot`, not as root (decided 2026-11-06), so the worker can start project containers without holding root on the machine. As root, install Docker from Docker's own apt repository (https://docs.docker.com/engine/install/ubuntu/), plus the rootless extras:

```sh
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras uidmap
systemctl disable --now docker.service docker.socket   # no root daemon
rm -f /var/run/docker.sock
# Server only: Caddy listens on 80 and 443, which a rootless daemon may only bind with this:
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/90-kanbot.conf && sysctl --system
```

Then as `kanbot`, in a real login session so the user's systemd session exists (on a server `ssh kanbot@<server>`; in WSL the `wsl -d kanbot` shell already is one; not `su`):

```sh
mkdir -p ~/.config/docker
echo '{ "data-root": "/srv/kanbot/docker" }' > ~/.config/docker/daemon.json   # images and volumes under /srv/kanbot
dockerd-rootless-setuptool.sh install
echo 'export DOCKER_HOST=unix:///run/user/1000/docker.sock' >> ~/.bashrc && . ~/.bashrc
docker run --rm hello-world   # check
```

Don't use Docker Desktop's WSL integration for setup A: Kanbot would then share Docker with Windows instead of having its own.

## 5. Get Kanbot's code

As `kanbot`:

```sh
git clone https://github.com/MatthewOsorio/kanbot.git /srv/kanbot/app
```

If the repository is private, add a read-only **deploy key** first: generate one with `ssh-keygen -t ed25519 -f ~/.ssh/kanbot_deploy` and add the `.pub` under the repo's Settings → Deploy keys. Then clone with the `git@github.com:` URL.

## 6. The `.env`

Create `/srv/kanbot/app/.env`, readable only by `kanbot` (`chmod 600 .env`):

```sh
COMPOSE_PROFILES=app             # setup A; on a server, app,public (adds Caddy) once M6 opens the app to a domain
POSTGRES_PASSWORD=<a long random string: openssl rand -hex 32>
ANTHROPIC_API_KEY=<your key>
DOCKER_SOCKET=/run/user/1000/docker.sock
KANBOT_REPOS_DIR=/srv/kanbot/repos
KANBOT_SESSION_SECRET=<openssl rand -base64 32>   # signs the login cookie; changing it signs you out
KANBOT_ENCRYPTION_KEY=<openssl rand -base64 32>   # encrypts the GitHub App's credentials; changing it loses them
KANBOT_DOMAIN=kanbot.example.com   # server only
```

Compose reads this file to fill in `docker-compose.yml`. Each container gets only the variables its service lists, never the whole file.

Optional: `KANBOT_WEB_PORT` and `KANBOT_DB_PORT` (default 3000 and 5432) if those ports are taken, e.g. by a `pnpm dev` on Windows in setup A. `KANBOT_DEFAULT_IMAGE` (default `node:24-bookworm`) is the image for projects that have none of their own (no devcontainer, nothing in Settings).

## 7. Start it

As `kanbot`, in `/srv/kanbot/app`:

```sh
docker compose up -d --build
docker compose ps            # db, web and worker running (caddy too on a server); migrate exited 0
docker compose logs worker   # "kanbot worker up (runtime: sdk)"
```

Then open `http://localhost:3000` (setup A: WSL forwards it to your Windows browser), or `https://kanbot.example.com` (setup B).

The first time, Kanbot shows **Connect GitHub**:

1. Click it. GitHub opens a pre-filled App; click **Create**.
2. Pick the repos Kanbot may work on (a side project, not necessarily Kanbot itself) and click **Install**.
3. Back in Kanbot, click **Sign in with GitHub**.

The account that created the App is the only one that can sign in. Always use the same address (`localhost`, not `127.0.0.1`): the App only knows the one it was created from. More repos later: **Add repos on GitHub** on Home.

What runs where:
- `db` is Postgres 16, on 127.0.0.1 only.
- `migrate` applies migrations, then exits.
- `web` is the Next.js app, on 127.0.0.1 only.
- `worker` uses host networking, so it can reach the QA apps that project containers publish on 127.0.0.1. It gets the Docker socket and `/srv/kanbot/repos`, mounted at the same path. Every project command runs in a container from the project's image (or `KANBOT_DEFAULT_IMAGE`), never in the worker's own container.
- `caddy` (profile `public`, servers only) serves HTTPS on 80 and 443.

## 8. Deploys from GitHub (setup B)

`.github/workflows/deploy.yml` redeploys after CI passes on `main`. It connects over SSH as `kanbot`, checks out the commit, and runs `docker compose up -d --build`. To turn it on, in the GitHub repo:

1. **Secrets** (Settings → Secrets and variables → Actions):
   - `DEPLOY_HOST`: the server's IP or domain.
   - `DEPLOY_SSH_KEY`: the private half of a new key pair made for this purpose. Add the public half to `/home/kanbot/.ssh/authorized_keys`.
   - `DEPLOY_KNOWN_HOSTS`: the output of `ssh-keyscan <host>`, which pins the server's identity.
2. **Variable** `KANBOT_DEPLOY` = `on`.

In setup A, update by hand: `git pull && docker compose up -d --build`.

## 9. Backups

Postgres is dumped nightly. On a server, copy the dumps off the machine, e.g. to DigitalOcean Spaces: create a bucket and an access key, run `apt-get install -y s3cmd` as root, then `s3cmd --configure` as `kanbot` with the Spaces endpoint (e.g. `nyc3.digitaloceanspaces.com`). Then add to `kanbot`'s crontab (`crontab -e`):

```cron
15 3 * * * cd /srv/kanbot/app && f=/srv/kanbot/backups/kanbot-$(date +\%F).sql.gz && docker compose exec -T db pg_dump -U kanbot kanbot | gzip > $f && s3cmd put -q $f s3://<bucket>/ && find /srv/kanbot/backups -name '*.sql.gz' -mtime +14 -delete
```

In setup A, drop the `s3cmd put` part. The dumps stay in `/srv/kanbot/backups` inside the distro; copy them out now and then (`\\wsl$\kanbot\srv\kanbot\backups` in Windows Explorer).

To restore: `gunzip -c <file> | docker compose exec -T db psql -U kanbot kanbot` on an empty database.

## Housekeeping

- The worker's **nightly cleanup** runs a minute after it starts and then every 24 hours. It prunes run logs older than 90 days (keeping each ticket's last run), worktrees that Done tickets still hold, and project images Kanbot built that nothing has used for a week.
- The shared package cache volume is not pruned. If it grows too large, stop the worker and run `docker volume rm kanbot-cache`; it fills again on the next installs.
- Updating by hand: `git pull && docker compose up -d --build`.
