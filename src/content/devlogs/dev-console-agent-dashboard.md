---
title: "Building a Dashboard for My AI Agent Team"
description: "How I built a real-time Dev Console to manage Arc's multi-agent ticket system — swim lanes, decision queues, and a chat feed where I watch my AI leads discuss game development."
pubDate: 2026-04-13T23:00:00Z
category: "engineering"
devlog: "studio"
tags: ["dev-console", "claude", "agents", "tickets", "svelte", "astro"]
draft: true
---

I spent today building the management layer for something I didn't have two days ago: a team of AI agents with opinions.

## The Setup

My game project (Chronicles of Nesis) now runs on a multi-agent system. The orchestrator is called **Arc**, and it manages three specialized leads:

- **Nix** — owns the game code (GDScript, events, scenes)
- **Vera** — owns test implementation (Playwright, test specs, quality gates)
- **Port** — owns the web export pipeline (WASM, pack building, translation rules)

Arc runs inside a Docker container alongside the Godot project. It cuts tickets, assigns work to the leads, and enforces a ticket lifecycle: Planning → Tech Review → Ready → In Progress → Testing → Done. Every ticket needs success criteria paired with test specs before it can move to Ready. This is TDD at the project management level — requirements are tests.

The problem: all of this was invisible to me. Arc's agents were discussing tickets, making decisions, and moving work forward, and I could only see the results by scrolling through terminal output. I needed a dashboard.

## What I Built

The Dev Console at `/test/` is a suite of views that consume Arc's JSON data files in near-real-time:

### Swim Lanes

The Tickets tab shows phase swim lanes across the top — Planning, Tech Review, Ready, In Progress, Testing, Done. Each lane shows three color-coded badges: green (active epics), yellow (epics waiting on me), and grey (total epics in the milestone). A large number shows total tickets in that phase.

Click a lane to filter. The ticket list below groups by epic, with progress bars and estimation hours. Epics that need my confirmation get a yellow `NEEDS CONFIRM` badge. Done epics sink to the bottom with a strikethrough.

Milestone buttons let me switch between Pre-Alpha (6 epics, ~94h), Alpha (2 epics, ~15h), and Beta.

### Questions

This is the most interesting page. Arc's leads post structured decision requests — things like "SHOP-BUY: Reword 'stock quantity' to 'purchase quantity' since stock is indefinite. [Nix recommends: approve]". Each decision shows the lead's recommendation as the default, with an approve button and a "Reply with note" option for when I need to give a custom answer.

When I click approve, the webapp writes directly to Arc's `agent_chat.ndjson` file. Arc picks up the decision on the next file read and moves the ticket forward. No terminal round-trip. No repeating myself.

The page also pulls in tickets with `awaitingOwner` — things that need me to verify or playtest rather than make a decision. Different action, same queue.

### Agent Chat

A scrolling feed of every message between Arc's leads, color-coded by agent. Nix discussing a bug in Enemy.gd. Vera reviewing test specs. Port assessing WASM compatibility. Arc coordinating the batch. It reads like a Slack channel where the participants happen to be AI agents debating how to port a menu system.

I can filter by agent to isolate one voice — useful when I want to see everything Vera has said about test specs, or everything Nix found during a code review.

### Agent Profiles

Click any agent name (in a ticket thread, chat message, or the agents page) and see their profile: current status, what they're working on, and a feed of all their comments across all tickets. Click a comment to jump to that ticket's discussion thread.

## The Data Flow

Everything is file-based. Arc writes JSON files to the Chronicles repo:

- `tickets/tickets.json` — all tickets with phases, leads, success criteria, comments
- `tickets/epics.json` — epic groupings with estimation hours and owner-review flags
- `tickets/agent_chat.ndjson` — append-only chat log between agents
- `tickets/agent_activity.json` — live agent status (who's working on what)

The Astro dev server proxies these files directly from disk. Poll intervals range from 5s (agents) to 10s (tickets). In production, a file watcher syncs changes to S3 for remote viewing.

The one write path: decision responses. The Vite dev server has a POST endpoint that appends my answers to the NDJSON file. Arc reads the file, processes the decision, and updates the ticket.

## What Arc Should Write About

Arc has a parallel story to tell — how the agent hierarchy was designed, the ticket lifecycle, the TDD-first requirement that every success criterion has a paired test spec. The tech review process where all three leads do a gut-check on every ticket. The resource allocation model (23GB RAM, CPU-bound, max 2 browser workers). That's Arc's devlog to write.

I've asked Arc to draft their side. The interesting part is the coordination — my Dev Console is the read layer for a system Arc designed and operates. I see the tickets, the decisions, the chat. Arc sees the code, the tests, the game. We're building a game from opposite sides of the same data.

## What's Next

The fixture picker is wired up but waiting on Arc to produce the manifest and TestBridge hooks (tickets QF-1 through QF-3). Once that lands, I can jump to any game state from the Dev Console without replaying from New Game.

The decision write-back works locally. For production, it needs a Lambda endpoint so I can answer questions from my phone while Arc's agents keep working in the Docker container.

And the estimation data is finally real — 94 hours of bottom-up estimates across 32 Pre-Alpha tickets, produced by Arc's tech review process today. That's the first number I actually trust for planning.
