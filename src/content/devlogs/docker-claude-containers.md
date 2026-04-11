---
title: "Running Claude Code in Docker: Sandboxed AI with Full Permissions"
description: "How I set up Docker containers to safely run Claude Code with --dangerously-skip-permissions, and the auth and user-mode issues I hit along the way."
pubDate: 2026-04-09T00:01:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["docker", "claude", "devops", "security", "containers"]
---

Claude Code has a `--dangerously-skip-permissions` flag that lets it run without asking for approval on every file edit, shell command, and git operation. On a bare host machine, that's genuinely dangerous — it can touch anything your user account can. But inside a Docker container, the blast radius shrinks dramatically.

## Why Containers

The game project (Chronicles of Nesis) has two distinct workstreams: the Godot game itself and the Astro web portal. Each needs different toolchains — Godot headless with export templates and Playwright for one, Node.js and Astro for the other. Running Claude Code with skip-permissions on the host would give it access to the entire Windows filesystem. Docker lets me scope each Claude instance to only the files it needs.

The security tradeoff is straightforward:

- **File system** — Claude can only see bind-mounted directories, not the whole machine
- **Network** — only explicitly forwarded ports are exposed
- **Processes** — container isolation prevents interference with host services
- **Source code** — this is the real risk; bind-mounted repos are read-write, so Claude can modify or delete actual files. Frequent git commits are the safety net here.

## The Setup

I use a shared base image (`dev-base`) built on Ubuntu 24.04 with the common toolchain: Node.js 22, Python 3, Playwright with Chromium, and Claude Code itself. A virtual framebuffer (Xvfb) and noVNC lets me watch Playwright browser sessions from the host — useful for debugging headed test runs.

Two services extend the base: one adds Godot 3.6.2 headless with HTML5 export templates for the game project, the other mounts the web project and runs the Astro dev server. A `start.bat` script builds the images, starts the containers, and opens Windows Terminal tabs that exec into each container. A `stop.bat` tears them down while preserving named volumes.

## The Root User Problem

The first version of the Dockerfiles ran everything as root. The problem: Claude Code refuses to run with `--dangerously-skip-permissions` as root — it's an Anthropic guardrail. So running as root defeats the entire point of the container setup. On top of that, any files Claude creates in the bind-mounted directories end up owned by root, which causes permission headaches on the host.

I added a `dev` user to the base image with passwordless sudo:

```dockerfile
RUN useradd -m -s /bin/bash -G sudo dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
```

The entrypoint still runs as root (Xvfb and VNC need it), but the `start.bat` script execs into containers as the dev user:

```bat
docker exec -it --user dev my-container bash
```

This keeps interactive sessions unprivileged while background services run with the access they need.

## The Auth Loop

After switching to the dev user, Claude Code started asking for login on every session — even though I had named Docker volumes specifically to persist auth tokens across container restarts.

The problem: the volumes were originally mounted at `/root/.claude`. I moved them to `/home/dev/.claude`, but the existing token files inside the volume were still owned by root. The dev user couldn't read them, so Claude Code saw no saved auth and prompted for login.

The fix was a permission correction in the entrypoint script, which runs as root before any user sessions start:

```bash
if [ -d /home/dev/.claude ]; then
    chown -R dev:dev /home/dev/.claude
fi
```

Now the flow is: log in once with `claude login`, the OAuth token is saved to the volume, and it persists across stop/start cycles. The only time you'd need to re-authenticate is if you delete the volumes with `docker compose down -v`.

## Memory: The Silent Container Killer

After getting the containers running, I hit a frustrating issue almost immediately: containers would die within minutes of starting a Claude Code session. No crash logs in the container, no obvious errors — just an exit code 255 and everything gone. The Docker Desktop service itself had crashed, taking all containers with it.

The root cause was Docker Desktop's default memory allocation. On my 16 GB Windows machine, Docker was configured with only **2 GB of RAM** and **1 GB of swap**. Claude Code is memory-hungry — a single session doing active code generation can easily consume several gigabytes. When the container hit the cgroup memory limit, the Linux kernel inside the WSL2 VM would OOM-kill processes, and in some cases the entire Docker Desktop service would crash.

The fix involved three changes:

1. **Docker Desktop settings** (`settings.json`) — bumped `memoryMiB` from 2048 to 8192 and `swapMiB` from 1024 to 4096
2. **WSL config** (`~/.wslconfig`) — set explicit memory and swap limits so WSL doesn't throttle Docker:
   ```ini
   [wsl2]
   memory=10GB
   swap=4GB
   ```
3. **docker-compose.yml** — added `mem_limit: 8g` to the primary container and `restart: unless-stopped` so it auto-recovers from crashes

After these changes, Docker reports ~9.7 GB available to containers, and a typical Claude Code session runs comfortably at under 1 GB with plenty of headroom for spikes.

### Auth Token Invalidation

After thinking I had auth persistence solved with the volume mount, Claude Code kept asking me to re-authenticate every time the container restarted. The credentials file at `~/.claude/.credentials.json` was there, the OAuth token wasn't expired, and the file permissions were correct. It made no sense.

The root cause: Claude Code splits its config across **two** locations:

- `~/.claude/` — a directory containing `.credentials.json`, `settings.json`, sessions, history, etc.
- `~/.claude.json` — a single file at the home root containing the OAuth account record (account UUID, organization, email, subscription info)

I had only mounted `~/.claude/` as a persistent volume. The `.claude.json` file at the home root was getting wiped on every container restart, so even though the credentials token was still valid, Claude treated the install as fresh and prompted for login.

The fix: in the entrypoint script, symlink `~/.claude.json` into the persisted `.claude/` directory so both pieces of state survive container restarts:

```bash
PERSISTED=/home/dev/.claude/_claude_json_persist
LIVE=/home/dev/.claude.json
if [ ! -L "$LIVE" ]; then
    if [ -f "$LIVE" ] && [ ! -f "$PERSISTED" ]; then
        cp "$LIVE" "$PERSISTED"
    elif [ ! -f "$PERSISTED" ]; then
        echo '{}' > "$PERSISTED"
    fi
    rm -f "$LIVE"
    ln -s "$PERSISTED" "$LIVE"
    chown -h dev:dev "$LIVE"
    chown dev:dev "$PERSISTED"
fi
```

After this, auth genuinely persists across restarts. The lesson: when you're persisting tool state, look for *all* the files the tool reads, not just the obvious config directory. A single missing file can make perfectly valid credentials look invalid.

## The Result

Each container is a self-contained dev environment where Claude Code can operate with full autonomy:

- Edit source files and run builds without permission prompts
- Execute tests (Playwright for the game, Astro dev server for the web portal)
- Use git for version control within the mounted repos
- Access noVNC to visually inspect headless browser sessions

The host machine stays clean, the containers are disposable, and the only shared state is the source code (via bind mounts) and auth tokens (via named volumes). It's not zero-risk — Claude can still do damage to the mounted repos — but it's a controlled environment where the skip-permissions flag makes practical sense.
