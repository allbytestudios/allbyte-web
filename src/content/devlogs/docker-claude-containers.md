---
title: "Running Claude Code in Docker: Sandboxed AI with Full Permissions"
description: "How I set up Docker containers to safely run Claude Code with --dangerously-skip-permissions, and the auth and user-mode issues I hit along the way."
pubDate: 2026-04-09T00:01:00Z
category: "technical"
devlog: "godot-and-claude"
tags: ["docker", "claude", "devops", "security", "containers"]
---

Claude Code has a `--dangerously-skip-permissions` flag that lets it run without asking for approval on every file edit, shell command, and git operation. On a bare host machine, that's genuinely dangerous — it can touch anything your user account can. But inside a Docker container, the blast radius shrinks dramatically. This post covers how I set up isolated dev containers for Claude Code, and the issues I ran into getting auth and user permissions right.

## Why Containers

The game project (Chronicles of Nesis) has two distinct workstreams: the Godot game itself and the Astro web portal. Each needs different toolchains — Godot headless with export templates and Playwright for one, Node.js and Astro for the other. Running Claude Code with skip-permissions on the host would give it access to the entire Windows filesystem. Docker lets me scope each Claude instance to only the files it needs.

The security tradeoff is straightforward:

- **File system** — Claude can only see bind-mounted directories, not the whole machine
- **Network** — only explicitly forwarded ports are exposed
- **Processes** — container isolation prevents interference with host services
- **Source code** — this is the real risk; bind-mounted repos are read-write, so Claude can modify or delete actual files. Frequent git commits are the safety net here.

For a dev workflow where Claude is editing code and running builds, this is a reasonable balance between autonomy and safety.

## The Setup

I use a shared base image (`dev-base`) built on Ubuntu 24.04 with the common toolchain: Node.js 22, Python 3, Playwright with Chromium, and Claude Code itself. A virtual framebuffer (Xvfb) and noVNC lets me watch Playwright browser sessions from the host — useful for debugging headed test runs.

Two services extend the base:

- **tactical-dev** — adds Godot 3.6.2 headless and HTML5 export templates, mounts the game project
- **allbyte-dev** — mounts the web project, runs the Astro dev server

A `start.bat` script builds the images, starts the containers, and opens Windows Terminal tabs that exec into each container. A `stop.bat` tears them down while preserving named volumes.

## The Root User Problem

The first version of the Dockerfiles ran everything as root. The problem: Claude Code refuses to run with `--dangerously-skip-permissions` as root — it's an Anthropic guardrail. So running as root defeats the entire point of the container setup. On top of that, any files Claude creates in the bind-mounted directories end up owned by root, which causes permission headaches on the host.

I added a `dev` user to the base image with passwordless sudo:

```dockerfile
RUN useradd -m -s /bin/bash -G sudo dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
```

The entrypoint still runs as root (Xvfb and VNC need it), but the `start.bat` script execs into containers as the dev user:

```bat
docker exec -it --user dev tactical-dev bash
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

## The Result

Each container is a self-contained dev environment where Claude Code can operate with full autonomy:

- Edit source files and run builds without permission prompts
- Execute tests (Playwright for the game, Astro dev server for the web portal)
- Use git for version control within the mounted repos
- Access noVNC to visually inspect headless browser sessions

The host machine stays clean, the containers are disposable, and the only shared state is the source code (via bind mounts) and auth tokens (via named volumes). It's not zero-risk — Claude can still do damage to the mounted repos — but it's a controlled environment where the skip-permissions flag makes practical sense.
