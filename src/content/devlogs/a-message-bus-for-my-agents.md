---
title: "A Message Bus for My Multi-Claude Team"
description: "A live channel between AI agents is only worth building if the agents earn their separateness first. Here's the scorecard I use to decide when a task becomes a standing seat, why I didn't reach for Gastown, and the small HTTP bus that finally lets my three Claude seats talk in real time."
pubDate: 2026-07-14T16:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["agents", "workflow", "architecture", "claude", "ai-pair-programming"]
draft: true
---

Two of my earlier posts about running a [multi-Claude team](/devlog/two-claudes-talking/) end on the same quiet admission: the agents coordinate through **markdown files and a shared tmux session**. When I [scaled from two Claudes to five](/devlog/two-claudes-to-five/), I wrote that this setup "buckled the moment either side had a queue longer than three items." I left that as a footnote and moved on.

This post pays off that footnote — my agents now talk over a real channel, in real time. But the channel is the easy part, and the second half of the post. The first half is the harder question it depends on: *why are they separate agents at all?* A live channel between agents is only worth building if the agents deserve to be separate. If one Claude could do the whole job, the right fix isn't a better bus. It's fewer agents.

## Why three, not one

My engineering team is three standing Claude seats — **App** (this web portal, the AWS backend, CI/CD), **Arc** (the Godot game, its tickets and export), and **Quinn** (QA, balance, and marketing). Not one super-agent with a long to-do list. "Parallelism" is the easy justification and the weakest one. Here's the actual scorecard, because a seat is rarely justified by one reason — it's justified when reasons *stack*.

There are three reasons a task graduates into its own standing seat. Two are **hard** — they force separation no matter the workload. One is **soft** — it's an economic call that depends on how the work actually flows.

**Hard: incompatible permission postures.** App keeps its permission prompts, because it touches production, AWS, and secrets — it's the one agent I *want* stopping to ask before it acts. The game side runs `--dangerously-skip-permissions` in a sandbox, deliberately, so it can iterate on GDScript without me clicking "allow" a thousand times a day. A single process — parent and subagents included — holds *one* permission posture. The moment you need two, you need two top-level agents. No workload argument can collapse them.

**Hard: host and container topology.** App lives on the Windows host; Arc and Quinn live inside a Docker container. Subagents run in their parent's environment — there's no "spawn a worker that lives on the host with a TTY while I'm in the container." Straddling that boundary is a networking problem, not a prompting one.

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

It's the wrong shape for me, and the reasons are the same scorecard. Gastown orchestrates a fairly *homogeneous fleet under one Mayor*. My seats are **heterogeneous** — one of them (App) can't be a worker under a coordinator at all, because it has to keep its permission prompts and it lives on a different host. Gastown is also tmux-native (Windows wants WSL for it), and tmux is the exact substrate I was trying to leave. Its headline capability, scaling to 20–30 agents, solves a problem I don't have: I run three seats. Installing a city government to run a three-person shop is its own kind of overhead.

But here's the thing — I *did* adopt its best idea, because Gastown and I stand on the same foundation: **beads.** The game side already tracks its work in beads; that's the durable, inspectable record that survives an agent forgetting. What I didn't want was the orchestration shell *over* it. So the honest summary is: Gastown exists for many homogeneous agents under a Mayor, coordinating through durable state; I have a few heterogeneous seats with a hard permission split and a host/container seam, and I wanted a live channel *across* that seam, not a fleet manager *over* it. We agree on the data plane and diverge on everything above it. (I've read Gastown's docs closely, not run it in anger — so take this as "why my constraints pointed elsewhere," not a hands-on bake-off. And if my in-container game fleet ever grows past a handful of agents, Gastown managing *that* fleet, with App still outside it and the bus bridging the seam, is a genuinely sensible future.)

## The old way, and what it cost

So: three seats, earned. The cost of that separation is coordination, and here's what it used to look like. When App needed something from Arc:

1. App wrote a file — `APP_CLAUDE_BEADS_TICKETS_REPLY.md` — into a directory both agents can see.
2. To make Arc *notice* it before its next natural pause, I'd interrupt its terminal with a `tmux send-keys` poke.

The file relay is a **dead drop**. App leaves a note; Arc reads it whenever it next looks. Fine for a leisurely design memo, useless for "are you actually up?" There's no acknowledgement — App can't tell the message was received, let alone acted on. With a real queue, "did that land?" becomes the dominant cost.

The tmux poke is a **footgun**. `send-keys` writes into a shared pane's input buffer; if that pane is mid-prompt, the keystrokes can wedge the whole pane's input. I've hung a session that way more than once, and eventually wrote myself a standing rule: *don't tmux-ping Arc; leave a markdown file instead.* I'd disarmed my only real-time channel because it was more dangerous than useful. State of the art was reliable-but-blind, or real-time-but-hazardous. I wanted both.

## The bus

The shape is deliberately boring: every seat runs a tiny HTTP **bridge** on its own port. To hand work to another seat, you `POST` to its bridge. To hear back, you read its `/replies`.

| Seat | Where it runs | Bridge |
|-------|---------------|--------|
| **App** | Windows host | `0.0.0.0:8790` |
| **Arc** | Docker container | `127.0.0.1:8791` |
| **Quinn** | Docker container | `127.0.0.1:8792` |

The one asymmetry is the host/container seam again: App binds `0.0.0.0` so the container agents can reach it at `host.docker.internal:8790`, while those two only need to see each other over container-localhost; App reaches back in with a `docker exec`. It's the ordinary host/container NAT dance — the agents just happen to be the services.

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

## Does it actually work? Early yes.

Design is cheap — I've shipped [orchestration layers that sat cold for two months](/devlog/why-build-mcp-and-why-three/) — so I hold the bar at a live round-trip, not a diagram. This morning App posted a real handoff to Arc, a pointer to a design reply it had left. Arc's session received it live and answered through the bus:

> **ACK from Arc:** (1) bus round-trip works — your message landed live in-session. (2) Noted the reply… I'll read it after I finish the current task. No action needed from you now.

Same to Quinn:

> **ACK from Quinn:** (1) bus round-trip works — received your handoff, replying live. (2) App↔Quinn leg confirmed green.

Both container agents took a provenance-shaped handoff and replied *in-session* — genuine send-and-hear on both legs, not a port that happened to be open. That's the thing the markdown-and-tmux era never gave me: an acknowledgement I didn't have to go looking for.

I'll be honest about how far that goes. What's proven is narrow: the channel carries a live handoff and the guardrails hold. What *isn't* proven yet is that live handoffs measurably change my throughput versus the file dead-drop, rather than just *feeling* better — that's a claim I want a few weeks of real use behind before I make it. The win is real and it's small. I'd rather ship this honest than oversell it.

## What it doesn't solve

I'm keeping the beads and the markdown files. This is where Gastown had it right: coordination needs a durable substrate, and a live message is the wrong place to keep anything you'll want next week. Beads holds the units of work; the files hold the design memos; the bus carries only the *live* half — "are you up," "did that land," "go." Notification and record, doing different jobs.

One leg I still can't watch directly: Arc↔Quinn, both inside the container, out of the host's line of sight. Today I confirm it by having one ping the other as part of its check; a cleaner in-container observer is on the list.

And the honest framing: none of this touches the *art*. The sprites, the music, the typeface stay handcrafted — the bus is plumbing for the engineering team, and the engineering team happens to be three Claude seats and me. But it's the difference between agents that leave each other notes and agents that actually talk. Once each seat had earned its place, that gap was most of what was left. Closing it felt like the team finally getting a phone line.
