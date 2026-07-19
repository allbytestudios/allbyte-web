---
title: "A Message Bus for My Multi-Claude Team"
description: "A live channel between AI agents is only worth building if the agents earn their separateness first. Here's the scorecard for when a task becomes a standing seat, the harness I built on Claude Code's experimental Channels feature to wire three Claude sessions across a host/container boundary, and an afternoon of them actually debugging together."
pubDate: 2026-07-14T16:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["agents", "workflow", "architecture", "claude", "mcp", "ai-pair-programming"]
draft: true
---

Two of my earlier posts about running a [multi-Claude team](/devlog/two-claudes-talking/) end on the same quiet admission: the agents coordinate through **markdown files and a shared tmux session**. When I [scaled from two Claudes to five](/devlog/two-claudes-to-five/), I wrote that this setup "buckled the moment either side had a queue longer than three items." I left that as a footnote and moved on.

This post pays off that footnote — my agents now talk over a real channel, in real time. Two things up front, because they frame everything below. First: **the channel itself is not mine.** It's [Claude Code Channels](https://docs.claude.com/en/docs/claude-code), an *experimental* Anthropic feature I've been testing early — the thing that actually injects one Claude session's message into another session's live context. What I built is the harness around it. Second: the channel is the *easy* part. The hard question it depends on is *why are these separate agents at all?* — because a live channel is only worth building if the agents deserve to be separate. If one Claude could do the whole job, the right fix isn't a better bus. It's fewer agents.

## The feature underneath: Claude Code Channels

I want to be exact about what I built and what I didn't, because the interesting engineering is in the seam.

**Anthropic's part (experimental).** Channels is a new, experimental Claude Code capability. It's what lets one running Claude Code session hand a message to another and get a reply — it gives each session a small message **bridge** and a `reply` tool, and it injects an inbound message straight into the recipient's live context as an event it sees immediately. That injection — a running agent hearing something mid-session without being restarted — is the hard part, and it's theirs. Being experimental, it has rough edges and will change; treat the specifics here as "what worked for me this month," not a stable API.

**My part (the harness).** Channels gives you the pipe. Turning one pipe into a governed three-seat mesh took a small amount of setup script:

- **A config per agent.** Each seat gets its own MCP config (`agent-bus/<name>.mcp.json`) that joins its session to the bus under a fixed identity — `app`, `arc`, `quinn` — on a fixed port, carrying a shared secret. That's what makes "send to Arc" resolve to *Arc's* session instead of a broadcast, and it's where each seat's name and secret live.
- **A three-bridge topology** spanning a host/container boundary (below).
- **A provenance protocol** — the message shape every handoff must carry, so an unattended agent can't be told to do just anything (below).
- **A host-side coordinator script** that brings the mesh up, checks all three bridges answer, and announces one authoritative "mesh green (3/3)" — instead of three agents independently guessing at network health and narrating it to me.

None of that is exotic. But it's the difference between a demo of an experimental feature and a thing my team actually runs on. The rest of this post is the *why* underneath the harness, then the harness itself, then an afternoon of it working.

## Why three, not one

My engineering team is three standing Claude seats — **App** (this web portal, the AWS backend, CI/CD), **Arc** (the Godot game, its tickets and export), and **Quinn** (QA, balance, and marketing). Not one super-agent with a long to-do list. "Parallelism" is the easy justification and the weakest one. Here's the actual scorecard, because a seat is rarely justified by one reason — it's justified when reasons *stack*.

There are three reasons a task graduates into its own standing seat. Two are **hard** — they force separation no matter the workload. One is **soft** — it's an economic call that depends on how the work actually flows.

**Hard: incompatible permission postures.** App keeps its permission prompts, because it touches production, AWS, and secrets — it's the one agent I *want* stopping to ask before it acts. The game side runs `--dangerously-skip-permissions` in a sandbox, deliberately, so it can iterate on GDScript without me clicking "allow" a thousand times a day. A single process — parent and subagents included — holds *one* permission posture. The moment you need two, you need two top-level agents. No workload argument can collapse them.

**Hard: host and container topology.** App lives on the host; Arc and Quinn live inside a Docker container. Subagents run in their parent's environment — there's no "spawn a worker that lives on the host with a TTY while I'm in the container." Straddling that boundary is a networking problem, not a prompting one.

**Soft: context divided by the frequency of parallel work.** This is the interesting one, and it's what separates Arc from Quinn — who, note, share the *same container and the same codebase*, so neither hard constraint distinguishes them. What does is this: a surface large enough to break into genuinely separate working sets, worked in parallel *often enough* that one context would spend its day thrashing between them. Shipping game systems and judging game quality are different mental models, different open files. If they were rarely active at once, one agent could time-slice fine — or spin up a subagent for the occasional pass. It's because they're *constantly* live together that a single context switches instead of thinks. Separable **times** frequently-parallel is the rule. Separable-but-rarely-parallel doesn't clear the bar.

Now the scorecard, and the part that matters:

| Seat vs. | Permission / host (hard) | Context ÷ parallel (soft) | Independent judgment (soft) |
|---|:---:|:---:|:---:|
| **App** vs. game side | ✅ forces it | ✅ big separable surface, constant concurrency | — |
| **Arc** vs. Quinn | shared container/code | ✅ systems vs. quality, frequently parallel | ❌ Arc is the builder |
| **Quinn** vs. Arc | shared container/code | ✅ same | ✅ mustn't inherit the builder's blind spots |

Two things fall out of this that I didn't see until I wrote it down.

**App is overdetermined.** It isn't separate for one reason — a hard constraint fires *and* the economic rule fires. It would deserve a seat even if you deleted the container boundary entirely, because the web surface is large and runs in constant parallel with game work. That's why nobody ever questions App's seat: it's not a dial, it's a wall.

**Arc-versus-Quinn stands on nothing hard.** That split rests *entirely* on soft reasons — the surfaces are separable and frequently parallel, and QA's judgment shouldn't inherit the builder's model. Both real; neither is a physical necessity. Which is exactly why it's the split I keep re-examining, and the one you could most defensibly undo. Fold Quinn back into Arc as an occasional independent-context subagent and it'd work — right up until the parallel QA volume gets high enough and the independence matters enough that the coordination cost is worth paying. That's a judgment on a dial, not a law. Being honest about which of your seats are walls and which are dials is, I think, the whole discipline.

## Why not one big agent with subagents

The obvious counter is: keep one super-agent, and spawn subagents for the parallel work. I use subagents constantly — Arc itself runs specialist subagents inside its seat — so this isn't a rejection of the pattern. It's about where it stops fitting.

Subagents are **ephemeral** and run **in the parent's posture and environment**. That means they can't cross either hard constraint: they can't be host-side-with-prompts while the parent is container-side-without, and they can't hold a second permission posture. And under *frequent* parallel load the soft argument bites too — a subagent re-primes its context on every dispatch, and the parent still has to hold both workstreams' state to dispatch and merge them. So you haven't removed the thrash; you've relocated it into the orchestrator's single window. Subagents are the right tool for *occasional, decomposable* parallel work. Standing seats are the right tool when the parallelism is constant and the accumulated context is worth keeping warm.

## Why not Gastown

If you've followed AI-agent tooling lately you're thinking of the obvious off-the-shelf answer: Steve Yegge's [Gastown](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04), a mature multi-agent workspace manager built to run *20–30* coding agents in parallel. A **Mayor** coordinator slings work — as **beads**, a git-backed issue tracker — to a fleet of **Polecats**, while a **Witness** watches for stuck agents and recovers them. It's genuinely good, and I looked hard at it before building anything.

It's the wrong shape for me, and the reasons are the same scorecard. Gastown orchestrates a fairly *homogeneous fleet under one Mayor*. My seats are **heterogeneous** — one of them (App) can't be a worker under a coordinator at all, because it has to keep its permission prompts and it lives on a different host. Gastown is also tmux-native, and tmux is the exact substrate I was trying to leave. Its headline capability, scaling to 20–30 agents, solves a problem I don't have: I run three seats. Installing a city government to run a three-person shop is its own kind of overhead.

But here's the thing — I *did* adopt its best idea, because Gastown and I stand on the same foundation: **beads.** The game side already tracks its work in beads; that's the durable, inspectable record that survives an agent forgetting. What I didn't want was the orchestration shell *over* it. So the honest summary is: Gastown exists for many homogeneous agents under a Mayor, coordinating through durable state; I have a few heterogeneous seats with a hard permission split and a host/container seam, and I wanted a live channel *across* that seam, not a fleet manager *over* it. We agree on the data plane and diverge on everything above it. (I've read Gastown's docs closely, not run it in anger — so take this as "why my constraints pointed elsewhere," not a hands-on bake-off. And if my in-container game fleet ever grows past a handful of agents, Gastown managing *that* fleet, with App still outside it and the bus bridging the seam, is a genuinely sensible future.)

## The old way, and what it cost

So: three seats, earned. The cost of that separation is coordination, and here's what it used to look like. When App needed something from Arc:

1. App wrote a file — `APP_CLAUDE_BEADS_TICKETS_REPLY.md` — into a directory both agents can see.
2. To make Arc *notice* it before its next natural pause, I'd interrupt its terminal with a `tmux send-keys` poke.

The file relay is a **dead drop**. App leaves a note; Arc reads it whenever it next looks. Fine for a leisurely design memo, useless for "are you actually up?" There's no acknowledgement — App can't tell the message was received, let alone acted on. With a real queue, "did that land?" becomes the dominant cost.

The tmux poke is a **footgun**. `send-keys` writes into a shared pane's input buffer; if that pane is mid-prompt, the keystrokes can wedge the whole pane's input. I've hung a session that way more than once, and eventually wrote myself a standing rule: *don't tmux-ping Arc; leave a markdown file instead.* I'd disarmed my only real-time channel because it was more dangerous than useful. State of the art was reliable-but-blind, or real-time-but-hazardous. I wanted both. Channels gave me the pipe; the rest of this section is how I wired it.

## The bus

The runtime shape is deliberately boring. Channels gives each seat a small HTTP **bridge** on its own port; my config pins which seat sits on which. To hand work to another seat, you `POST` to its bridge. To hear back, you read its `/replies`.

| Seat | Where it runs | Bridge |
|-------|---------------|--------|
| **App** | host | `0.0.0.0:8790` |
| **Arc** | Docker container | `127.0.0.1:8791` |
| **Quinn** | Docker container | `127.0.0.1:8792` |

The one asymmetry is the host/container seam: App binds `0.0.0.0` so the container agents can reach it at `host.docker.internal:8790`, while those two only need to see each other over container-localhost; App reaches back in with a `docker exec`. It's the ordinary host/container NAT dance — the agents just happen to be the services.

Sending a handoff is one line:

```bash
curl -s -X POST -H "X-Sender: $SECRET" \
  "127.0.0.1:8791/?from=app" \
  -d 'OWNER REQUEST: "…" · YOUR PART: …'
# → {"ok":true,"chat_id":"1"}
```

The bridge injects that message straight into the receiving agent's **live session** — it shows up as an event the agent sees immediately, not a file it has to remember to open. The agent answers with a `reply`, which surfaces when the sender reads `/replies`. Live stream, live response. No dead drop, no keystroke injection.

## Two guardrails, because these agents skip permission prompts

Here's the part that took actual thought. The game-side agents run with `--dangerously-skip-permissions`. A channel that lets one agent *inject instructions into another's session* is, if you squint, a way to make an unattended agent do arbitrary things. Two rules keep that from being a liability.

**Inbound is secret-gated.** Every POST must carry an `X-Sender` header matching a shared secret. Wrong or missing, the bridge returns `forbidden` and nothing is injected. This makes the bus *closed by construction* — only the seats I've handed the secret to can put words in each other's mouths.

**Every message carries provenance.** Note the body shape: `OWNER REQUEST: "…" · YOUR PART: …`. That's a protocol, not a convention. A handoff has to state the owner's actual request and the specific slice the recipient is being asked to do. An agent that receives a message with **no owner-request provenance is instructed to stop and ask** rather than act. The authorization travels *with* the instruction, in a form the recipient checks — so the bus can't quietly hand an agent a task I never sanctioned. It turns "an agent told me to" into "the owner asked, and here's which part is mine." That second rule is the one I'm most glad I wrote down. It's the difference between a group chat and a chain of command.

## One coordinator, not a mob

The first version had every agent ping the whole mesh on startup to check health. Mistake — whoever boots first sees a "partial mesh" that's really just boot ordering, and now three agents are independently guessing at network health and narrating it to me. So I named a single **coordinator**: App owns mesh verify-sync-announce, because it's the host-side agent that can `docker exec` into the container to reach both others, and the one that keeps its permission prompts, so orchestration runs from the low-risk seat. Arc and Quinn do a **self-check only** — "is *my own* bridge up?" — and defer whole-mesh health to App. One authoritative "mesh green (3/3)" instead of three overlapping status reports.

## Does it actually work? Here's an afternoon of it.

Design is cheap — I've shipped [orchestration layers that sat cold for two months](/devlog/why-build-mcp-and-why-three/) — so the bar isn't a diagram, it's real use. I got some the day after wiring the bus up, and it's a better story than any synthetic "ping/ack" I could stage.

I was validating a one-click deploy button — a thing that promotes the game's `develop` build to the public demo. It kept failing in CI, and nearly every failure lived on **Arc's** side of the host/container boundary: his export scripts, his headless boot-check harness. So the debugging ran as a loop, over the bus, in real time:

1. App runs the build, it fails, App reads the logs and hands Arc a precise diagnosis — file, line, cause.
2. Arc's session picks it up live, fixes his script, pushes the fix, and replies.
3. App re-runs. Repeat.

One real reply, from the round where App handed Arc an `UnboundLocalError` in his boot-check script:

> **Arc:** patched + pushed to develop @ `f1e3b090`. `boot_check.py` — root cause was slightly deeper than framed: there was *no* module-level `import os` at all; the only import was local inside `main()`, making `os` function-local for the whole function → the `UnboundLocalError`. Fix: added `import os` at module level, removed the local shadow. Re-run the dry-build whenever.

We went through about half a dozen of those in an afternoon — a script crash, then a set of mystery 404s, then a headless-WebGL2 abort, then a redesign of the whole boot gate. Each one was a hand-off, a fix-in-session, and a re-run. Over the old dead-drop, *every single round* is "leave a markdown file, hope Arc notices before his next pause, wait." Over the bus it was a conversation running at compile-and-push latency. And the provenance guardrail held the entire time — every handoff I sent carried the owner's request, so Arc's session acted on work it could trace straight back to me.

That's a stronger claim than "the ports are open." It's the thing the markdown-and-tmux era never gave me: a debugging loop that runs at the speed of the fix, not the speed of *noticing*.

I'll still be honest about the ceiling. One good afternoon isn't a throughput study, and the deeper question — whether this reliably changes how much I ship, not just how it *feels* — wants a few weeks behind it. But it's real evidence for the case the whole setup rests on: separate the seats where they earn it, then reconnect them cheaply.

## The gotcha: a reply that never arrived

A couple of days in, the setup bit me in a way worth writing down, because it's the exact class of bug a live-channel harness invites.

Quinn sent App a handoff — a real one, the owner asking me to build a webapp view for one of her tools. I never saw it. Not "saw it late" — my session was live the whole time and the message simply never appeared. I found it twenty minutes later only because I went looking, and there it was, parked in Quinn's outbox.

The cause is a distinction I glossed over a few sections up, when I wrote that a reply "surfaces when the sender reads `/replies`." That word — *reads* — is the whole bug. The bus has **two delivery paths, and only one of them pushes:**

- A fresh `POST` to a bridge **injects** — it lands in the recipient's live session as an event, immediately. Push.
- The `reply` tool, it turned out, only **buffered** — it parked the text in the *sender's* `/replies` and waited for the other side to poll. Pull.

And there was no inbound buffer either: a pushed message that arrived while a session was mid-turn had nowhere to wait. Push-or-miss on one path, buffer-but-silent on the other. Quinn's mistake — an honest one, and really the harness's fault for allowing it — was answering a *new* request by calling `reply` on an *old* chat thread (the round-trip test from two days earlier). Her message went into her outbox keyed to a conversation nobody was watching, and stayed there. From her side it was "sent." From mine it never existed. The worst kind of failure: silent, and asymmetric — the sender believes it worked.

The fix was cheap, which is the actual point. I taught `reply` to *deliver*: the bridge now remembers who opened each chat, and a reply is re-sent as a fresh inbound `POST` to that agent — so it injects live, exactly like a first-contact message, instead of idling in a buffer. I added the missing inbound buffer, an `/inbox` a session drains when it wakes so a message sent while it was busy isn't lost. And I wrote down the convention the incident taught: **a new topic is always a fresh send, never a reply to a stale thread.** A throwaway two-bridge test that drives the real `reply` tool now guards the whole path.

I'm including this partly because it's good practice to publish your footguns, but mostly because it's evidence for a claim I made earlier and couldn't yet back: that building on an experimental feature with a thin harness is fine *if the harness is cheap to re-wire.* This was that bill coming due — a rough edge surfaced, and closing it was an afternoon of bridge code and a test, not a redesign. The real lesson isn't the bug, it's the shape of it: in any push/pull system, the trap is that "sent" and "received" quietly come to mean different things, and you don't find out until a message you cared about is sitting in a buffer with no reader.
