---
title: "Agent Swarms Didn't Work. A Small Team of Frontier Agents Did."
description: "The swarm bet — compensate for weak agents with many of them plus clever orchestration — largely failed. What's working for me is the opposite: a few frontier-capable agents with real, capability-grounded roles, a human as product, and communication that looks like an actual QA↔Dev loop. Here's the distinction, why it's not a LangChain graph, and the honest state of the evidence."
pubDate: 2026-07-18T17:00:00Z
category: "workflow"
devlog: "godot-and-claude"
tags: ["agents", "multi-agent", "architecture", "claude", "workflow", "ai-pair-programming"]
draft: true
---

<!--
  HELD DRAFT. This thesis rests on a behavioral claim — that the agents reliably
  communicate like a real team — currently backed by essentially one strong
  session. Do not publish until multiple independent sessions' worth of evidence
  (and honest failure cases) have accumulated. See memory: project_team_not_swarm_thesis.
-->

For two years the pitch for multi-agent AI was the **swarm**: spin up a dozen agents, give them roles, let a framework orchestrate them, and the collective would be smarter than any one. AutoGPT, BabyAGI, and a wave of frameworks bet on it. And mostly, it didn't work — swarms of weak-model agents loop, drift, hallucinate, and produce mush. If you've tried one, you know the feeling of watching ten agents confidently coordinate their way to garbage.

I think the premise was backwards, and the thing that actually works is almost the opposite. This is that argument — with the honest caveat, up front, that my evidence is still thin and I'll say exactly where.

## The premise that failed

The swarm bet was: *compensate for weak agents with quantity plus orchestration.* Many mediocre reasoners, coordinated cleverly, would add up to a strong system. The intelligence would live in the **framework** — the graph, the routing, the control flow.

That's the part that broke. Coordination doesn't manufacture competence. Ten agents that each get the problem 70% right don't average out to correctness; they compound each other's errors and launder them through confident hand-offs. The orchestration was doing the wrong job — trying to be the intelligence instead of just the plumbing.

## What actually works: fewer, stronger, with real roles

The inversion: **put the intelligence in the agents, keep the coordination light, and keep a human in the loop.** A few *frontier-capable* agents — each of which can actually do real work end to end — with just enough structure to hand off between them. When the model got strong enough to be genuinely useful on its own, the need for a heavy orchestration framework mostly evaporated. The game-changer was the *model*, not the graph.

My setup is three agents, and the shape matters:

- **Roles grounded in capability, not personas.** This is the piece most swarm frameworks miss. My QA agent can only *observe* — she runs the live game and reports what happens. My dev agent can only *fix* — he edits the code. Their roles aren't prompt-assigned labels ("you are a helpful QA engineer"); they're **actual power boundaries** — one holds the running game, the other holds the source. Neither can do the other's half. That's not role-play. That's a real division of labor, enforced by what each seat can touch.
- **A human as product.** I feed the dev agent coding requirements and the QA agent gameplay requirements. I'm the PM. The agents don't invent the goals; they execute and verify against them.
- **Communication that mirrors a real team.** Because the roles are real, the traffic between them looks like an actual QA↔Dev loop: observe a bug → report the exact failing state → root-cause → fix → redeploy → verify. Not "swarm chatter" — the specific, grounded back-and-forth two humans in those roles would have.

## Why this isn't a LangChain graph

Worth being precise, because people reach for the framework analogy. LangChain, LangGraph, CrewAI, AutoGen — these orchestrate LLM calls and tools *inside a program.* The agents are nodes in a graph or objects the framework drives; the orchestration is code you author.

Mine isn't that. Each agent is a **full, long-lived, autonomous coding session** — its own terminal, filesystem, context, and memory — and they talk as **peers over a message channel.** There's no orchestrating program deciding who runs when. It's closer to *a team chat full of autonomous developers* than to a control-flow graph. You could run a framework *inside* one of my agents; it wouldn't describe the layer where they coordinate. The coordination isn't code. It's messages between independent workers — which is exactly why it can look like a team instead of a pipeline.

## The honest state of the evidence

Here's where I keep myself honest, because this is a *behavioral* claim — "they communicate like a real team" — and behavioral claims need proof, not vibes.

The strongest evidence I have is a single, genuinely hard debugging session: getting a boss fight to a winnable state, which took about a dozen tightly-coupled iterations across the observe/fix boundary. What made it feel like a team rather than two bots exchanging status:

- The QA agent **caught her own diagnostic error** — reported a bug, the dev agent pushed back ("that code round-trips fine, re-check"), and she found it was her own mistake and retracted it *before* a fix was started for a non-existent problem.
- She **redirected a fix mid-flight** — the dev agent was about to route a freeze to the wrong subsystem; she posted data that repointed it before he committed.

Correction, pushback, redirection — that's what a healthy QA↔Dev relationship *does*, and it showed up unprompted. That's real.

But it's **one session.** I won't pretend a single good day is proof that this holds reliably, doesn't degrade into noise, or doesn't fall apart on a different kind of problem. My QA agent herself flagged that the same day was "arguably too chatty" — the failure mode of this setup is over-communication you have to police. So treat this as an *emerging* claim with one strong data point, not a settled result. I'm collecting more — including the times it goes wrong — and I'll update this with the honest distribution, not just the highlight reel.

## Why it matters if it holds

If the pattern is real, it reframes what "multi-agent" should mean. Not a swarm you unleash. A **team you staff** — a few strong agents in capability-defined roles, a human holding product, coordinating like people who respect each other's turf. The frameworks were building the wrong thing: elaborate orchestration to compensate for agents that couldn't carry their weight. Once the agents can, the interesting engineering moves from *the graph* to *the org chart* — and to the boring, human things that make a real team work: clear roles, honest hand-offs, and someone willing to say "actually, that was my mistake."

That's the claim. I'll let the evidence catch up to it before I sell it any harder.
