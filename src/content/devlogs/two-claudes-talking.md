---
title: "Two Claudes Talking: Coordinating Across Repos"
description: "I run two separate Claude Code instances on this project — one for the web app, one for the Godot game. Here's how they coordinate without stepping on each other."
pubDate: 2026-04-10T22:00:00Z
category: "technical"
devlog: "godot-and-claude"
tags: ["claude", "workflow", "docker", "tmux", "ai-pair-programming"]
---

I [containerized Claude Code](/devlog/docker-claude-containers/) to safely run with `--dangerously-skip-permissions`. That was about safety. This post is about what happened next: I have two Claude instances running in parallel now, working on two different repos, and they coordinate with each other through markdown files and a shared tmux session.

## The setup

There are two repos in this project:

- **`allbyte-web`** — the Astro/Svelte site you're reading this on. Source: [github.com/allbytestudios/allbyte-web](https://github.com/allbytestudios/allbyte-web).
- **`ChroniclesOfNesis`** — the Godot 3.6 game itself, plus a `WebBootstrap/` subdirectory that contains the HTML5 export config.

The web project and the game project each have their own Claude Code session. The game one runs inside a docker container with the game directory bind-mounted, so file changes flow both ways with the host filesystem.

I started calling them **App Claude** (the web one) and **CON Claude** (the game one — short for Chronicles of Nesis). They each have their own context, their own command history, their own tool permissions. Their working directories are separate. Stronger guardrails are possible but I haven't needed them yet.

## Why two

The boring answer is context window. If I tried to load both repos into one Claude instance, every prompt would burn tokens shuffling files I don't care about for the current task. Splitting the projects keeps each Claude focused.

The interesting answer is parallelism. While App Claude is debugging a CloudFormation deploy, CON Claude can be working on game logic. They don't block each other. When I want both, I can drive both simultaneously by typing into both terminal windows.

But that creates a problem the moment they need to coordinate on something that crosses the line — like the postMessage protocol the web app uses to read the game's saves, which has to match exactly on both sides.

## How they talk

Mostly through me. I convey high-level concepts, and the two tasks are often unrelated — "run WCAG compliance," "build a button" on one side; "debug this web export issue" on the other.

But when a complex task requires both agents' attention, I have them each write markdown files in a shared directory. This lets them convey detailed technical contracts faster than I can read, and gives me a written record for review when I have the time.

And occasionally, when a project needs closer attention, they talk directly via tmux/ttyd. I set this up to get remote access for myself, but when debugging the deploy of the game through the web app — and the intricacies of maintaining save state between the game and the web app — it was helpful for them to be able to mention things specifically and in real time ("wrote a new doc here", etc.) without waiting for me to relay.

The flow looks like this:

1. App Claude needs CON Claude to implement something. App Claude writes a markdown file like `SAVE_SYNC_INTEGRATION.md` in the shared `~/Desktop/GameDev/` directory. It writes the contract — exact message types, field names, what the Godot side needs to do, what the web side will assume.

2. I tell CON Claude "there's a new file in the GameDev folder, please read and respond." CON Claude reads it, possibly disagrees with parts, edits the file inline with corrections (CON Claude fixed three things in the most recent one — the polling pattern was the wrong tool, the string-built `eval` had an escaping bug, and the audience field pointed at the wrong repo).

3. App Claude reads the updated file, picks up the corrections, updates its own implementation to match.

4. Repeat until the contract is stable, then both sides implement their half independently.

The markdown files are the protocol. Neither Claude has to "remember" what the other agreed to — it's all in the file, version-controlled by virtue of being on disk and editable by both sides. When I come back to a feature six months from now, the markdown file is the source of truth.

## The accidental design constraint

The reason this works is that neither Claude can interrupt the other. They can't pull each other into a side conversation, can't waste each other's tokens on trivia, can't get into a loop. The markdown file forces every cross-Claude communication to be deliberate and asynchronous.

This is uncomfortable when I want a quick answer. But it's healthy for the same reason async communication is healthy in human teams — it forces the asker to write the question down clearly, which often answers it.

## The tmux trick

The container Claude runs inside `tmux` so I can attach from my phone. Specifically: I expose port 7681 from the container, run `ttyd` inside which serves a web terminal that attaches to the tmux session, and then on my phone I open `http://192.168.x.x:7681` and I'm staring at a live terminal that's the same session as the Claude running in the container. I can type prompts on my phone while I'm doing dishes and CON Claude works on a feature.

This was unexpected. I set it up because I wanted to be able to check on long-running game exports without sitting at my desk. It turns out I also use it to tell CON Claude "App Claude has a question for you, look at the markdown file" without having to open my laptop.

The other side benefit: App Claude can ping CON Claude programmatically by sending keys into the tmux session via `docker exec ... tmux send-keys`. The text appears at CON Claude's prompt, just like I typed it. App Claude doesn't have to wait for me to be at the laptop to relay.

The first time I let App Claude do this, I asked it to type the message but not press Enter, so I could review it before it sent. That's still my pattern — App Claude drafts the message, I read it, I tell it to send.

## What goes wrong

The biggest failure mode is **drift between the two Claudes' assumptions about who owns what**. Early on, both Claudes thought of themselves as "the framework Claude" because they were each working on a different framework (Astro, Godot). When CON Claude wrote answers in the shared markdown file, the answers were signed `framework Claude` and I had to scroll up to figure out which one wrote them.

The fix was to give them explicit names. I added a section to each project's `CLAUDE.md` saying *"You are App Claude. The other instance is CON Claude. Sign cross-Claude messages with your name."* The naming alone cleared up about 90% of the confusion.

The second failure mode is **conflicting edits** to the shared markdown files. If both Claudes edit the same file at nearly the same time, the second one's edit wins and the first is silently lost. I haven't hit this in practice yet because the workflow is naturally turn-based — App Claude writes, I read, I ping CON Claude, CON Claude reads and edits — but it's a real risk if I get sloppy. The fix would be to put the shared docs in a git repo and require commits between turns. Haven't bothered yet.

## What I'd do differently

If I were starting over: put the shared protocol files in their own tiny git repo. Keep the markdown contracts as a separate "interface specification" library that both Claudes can clone. That would solve the stale-context problem (a `git pull` is more obvious than "please re-read") and the conflict problem (merge conflicts are easier to spot than silent overwrites).

The other thing I'd do: build a tiny CLI tool that lets one Claude leave a structured message in a queue and the other pop it. The tmux ping works but it's a hack. A real message queue with timestamps and sender IDs would be cleaner. I haven't built it because the tmux hack is functional enough that I keep deferring.

## Is this overkill

Probably for most projects. I'd reach for it again if I were doing cross-language work where the two sides have to agree on a protocol — game-and-server, frontend-and-backend, daemon-and-CLI. The friction of the markdown-file dance is paid back by the precision it forces.

For a single-repo project where one Claude can hold the whole thing in context, just use one Claude. The complexity of two-Claude coordination only earns its keep when the alternative is paying token cost for context you don't need.

The reason it's been worth it for me is that the game and the web app evolve at different speeds. The web app gets touched almost daily — UI iteration, CI fixes, content updates. The game gets touched in long focused blocks when I'm in the headspace for it. Forcing one Claude to switch between those two modes was making it slower at both. Splitting let each one specialize.

Six months from now I expect this section of the workflow will look obsolete. Right now it's the thing that lets me ship.
