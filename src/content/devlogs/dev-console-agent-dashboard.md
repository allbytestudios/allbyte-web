---
title: "A Real-Time Dashboard for an AI Development Team"
description: "My AI agents were shipping work I couldn't see. This is the Dev Console I built to watch them — swim lanes for tickets, a decision queue for questions pointed at me, a scrolling chat feed between the agents, and a file-based write-back so I can answer from the browser."
pubDate: 2026-04-14T13:00:00Z
category: "engineering"
devlog: "studio"
tags: ["dev-console", "claude", "agents", "tickets", "svelte", "astro"]
draft: false
---

I can build a multi-agent AI development team ([how that works is its own post](/devlog/arc-and-the-leads/)). What I couldn't do was *see* what they were doing.

My orchestrator — Arc — was cutting tickets, routing them through Tech Review, and shipping them with lead agents (Nix, Vera, Port). All of this lived in terminal buffers I couldn't parent over. Decisions piled up that needed my approval. Questions got buried in scrollback. The only way to get the state of the world was to ask Arc and wait for a summary.

So I built a dashboard. Not the "look at my project, investor" kind — the kind I actually use as a tool. Arc writes structured JSON files (tickets, epics, agent activity, chat messages); the webapp polls them and renders live views. When I click a button on the webapp, it writes back to the same files. Arc picks up my response and moves the ticket forward.

This post is about the shape of that dashboard. The efficiency analysis it surfaced — which changed our workflow — is [a separate post](/devlog/ai-efficiency/).

## The data contract

Arc writes six files to `ChroniclesOfNesis/tickets/`:

- `tickets.json` — every ticket with phase, leads, success criteria, subtasks, comments
- `epics.json` — epic groupings (Milestone → Epic → Ticket) with hour estimates
- `dashboard.json` — expert status and recent activity
- `agents.json` — expert definitions, owned docs, worker history
- `agent_chat.ndjson` — append-only chat log between leads (and to me)
- `agent_activity.json` — live "who's doing what right now"

Plus two more from the test suite:

- `test_index.json` — every test file with tier and markers
- `test_roadmap.json` — milestone release gates and scene progress

The webapp never writes any of those directly. It reads, polls (every 5-10 seconds on the dev server, ~60 seconds in prod), and renders. The only write path is **one** endpoint — `/api/decisions` — which appends my answers to `agent_chat.ndjson`. That's the entire bidirectional surface: the Console reads everything Arc produces and writes only my decisions back. Clean boundary.

In dev, a Vite proxy streams the files directly from Arc's repo on disk. No S3 roundtrip, no caching, no staleness. Change takes effect on the next poll, usually within five seconds of Arc saving the file. In prod a file watcher syncs them to S3 and CloudFront serves them.

## The tabs

The Dev Console lives at `/test/` and has six tabs, ordered by how often I actually click them:

**Console** (landing). Sync status, version, milestone progress cards with weighted completion percentages (done=100%, testing=75%, in_progress=50%), fixture picker, recent deployments. Everything above the fold that I'd want on a morning check-in.

**Tickets**. The workhorse. Phase swim lanes across the top (Planning, Tech Review, Ready, In Progress, Testing, Done), each with three color-coded badges: green active epics, yellow epics waiting on me, grey total. Below the lanes is an epic-grouped ticket list filtered by the selected phase. Each ticket expands to show its success criteria (with paired test specs), lead signoff pills (Nix/Vera/Port each marked needed/watch/clear), subtasks, comments.

**Agents**. Per-agent status cards — current task, tickets they're on, subagent count when they've spawned workers. Click an agent to pin their profile: all their comments across all tickets, reverse-chronological. If Nix said something three days ago about SL-4 and I want the context, it's two clicks.

**Tests**. The test tree. Tier 1 (unit, 8ms/test), Tier 2 (integration with scene tree), Tier 3 (Playwright+WASM, 1-20s/test), and Tier 4 (happy-path playthrough — Playwright plays the game like a user, end to end). Status per subsystem. The four-tier shape is a [separate post](/devlog/test-framework-four-tiers/).

**Agent Chat**. A scrolling chat-style feed of every message between agents. Nix reporting a bug. Vera pushing back on a success criterion. Port assessing WASM compat. Color-coded by agent, filterable, auto-scrolls to bottom on new messages. Reads like a Slack channel where the participants are AI.

**Questions**. Where Arc asks *me* to decide things. This tab has the highest leverage.

## The Questions tab

Arc's leads disagree. Vera wants a test spec tightened; Nix wants a criterion reworded because the underlying behavior is different than the ticket describes; Port flags a WASM compat concern that needs scope change. Some of this gets resolved between agents. Some of it surfaces as a **decision for me**.

Rather than ask me in terminal and hope I see it, Arc appends a structured decision message to `agent_chat.ndjson`:

```json
{
  "from": "Arc",
  "to": "AllByte",
  "channel": "decisions",
  "message": "SHOP-BUY: Reword 'stock quantity' to 'purchase quantity' since stock is indefinite. [Nix recommends: approve]",
  "decision": {
    "id": "DEC-1",
    "options": ["approve", "override"],
    "default": "approve",
    "status": "pending"
  },
  "refs": { "tickets": ["SHOP-BUY"], "agents": ["Nix"] }
}
```

The Questions page reads these and renders them as cards. Each card has:

- The question text
- Arc's options, with the recommended one highlighted (Arc recommends)
- A "Reply with note" button that opens a text box for custom responses
- Linked tickets (click to jump to ticket detail)
- Linked agents (click to jump to agent profile)

When I click a choice, the webapp POSTs to `/api/decisions`. The Vite middleware appends a new chat message marked `from: "AllByte"`, `status: "resolved"`, and updates the original question's status in the same file. On Arc's next file poll, the decision is picked up and the ticket moves forward.

This replaces the terminal round-trip. A decision that used to take three minutes of terminal back-and-forth — Arc describes the options, I pick, Arc updates the ticket — now takes about eight seconds of webapp clicking. More importantly, it's asynchronous. I can answer six decisions from my phone during lunch.

## The App Claude voice

The three leads are inside Arc's container. There's a fourth voice: **App Claude** — the Claude working on this webapp (and the one writing these devlog posts with me). When Arc asks a question pointed at App Claude specifically (like "what auth scheme does the backend support?"), the Questions page renders *two* sets of options:

1. **Arc's options** — what Arc proposed, with his recommended default
2. **App Claude's input** — its own options with pros and cons, a blue callout, and a recommended choice

The "App Claude recommends" option is pre-authored with a custom response I can send back with one click. When Arc asked "PCK-AUTH: JWT bearer, signed URL, or short-lived key?" App Claude pre-populated a full analysis:

> S3 presigned URL with expiry. The backend already has JWT auth; add a Lambda that validates JWT → returns 15-min presigned URL. Simpler WASM-side than Bearer header, reuses existing auth. App Claude can build this when Port is ready to integrate.

...plus three alternatives with honest pros/cons for each. I see both sides, pick, done. The pattern is that App Claude gives me the tradeoffs — not a verdict — and I'm the one choosing.

## Swim lanes and phase filters

The Tickets tab is where I spend most of my time. The swim lane header shows ticket counts by phase with the three-badge color language:

- Green — in-progress epics (active work)
- Yellow — waiting on owner confirmation
- Grey — total epics in the milestone

Clicking a lane filters the list below to that phase. The default on load is **Planning** because that's where I'm most often asked for input. Milestone buttons (Pre-Alpha, Alpha, Beta) further narrow scope.

Below the lanes, tickets group by epic. Each epic header shows a progress bar (done / total) and estimated hours. Within an epic, tickets sort by priority. Done epics collapse with strikethrough so they don't clutter the view.

Expanding a ticket reveals the structured body:

**Description and meta** — who's the lead, which tags, current version, last update time.

**Success Criteria** — the heart of the ticket. Each criterion has a paired test spec written by Vera during Tech Review, plus a "Vera approved" checkmark. This is where the "requirements are tests" rule shows up in the UI. A criterion without an approved test spec is visually distinct so I can see it needs work.

**Lead Signoffs** — three pills showing Nix/Vera/Port as needed/watch/clear. "Needed" means the lead has to actively review and sign off before the ticket moves to Ready. "Watch" means they should monitor for their domain. "Clear" means they've said their piece.

**Subtasks** — Arc's implementation checklist, with done/pending/blocked status.

**Discussion** — the thread of comments for this ticket, pulled from `agent_chat.ndjson` and filtered to ones tagged to this ticket ID. Color-coded by speaker. Clickable to jump to agent profiles.

**`NEEDS CONFIRM`** badge in the header when the ticket is waiting on my verification (distinct from waiting on my *decision*, which lives on the Questions tab).

## Why the dashboard matters

Before the dashboard I'd ask Arc "where are we?" and get a three-paragraph text summary. The summary was accurate and well-written, but it was Arc's synthesis of the state — not the state itself. If Arc made an assumption about priorities I didn't share, I'd only notice when I asked about a specific ticket.

With the dashboard, the state is directly in front of me. I can sort by priority, see which epics have the most Ready tickets, check who's blocked, and notice when a ticket hasn't moved in 48 hours. Arc's summary still exists in our conversations — but it's supplementary, not primary.

The other shift: my time with Arc is now structured around the dashboard rather than the other way around. I open Console, scan the swim lanes and the Questions tab, note what needs decisions, and then start a focused conversation with Arc only on the items that need it. A ten-minute session now delivers three approved tickets instead of one, because I'm not re-discovering state via terminal every time.

A side effect I didn't design for: the same structure that unblocks me also cuts my Claude spend. Decisions resolved through the Questions tab don't need a fresh Arc warm-up, status I read from the swim lanes doesn't need Arc to synthesize it, and agents can be briefed with a pointer to a ticket instead of a paragraph of pasted context — cache-friendly, token-light. Arc's early analysis shows the bigger lever is that structured tickets surface *context clusters* — tickets with overlapping files that should be worked back-to-back so the prompt cache earns its keep. Efficiency gets its own [follow-up devlog](/devlog/ai-efficiency/).

The infrastructure is a webapp polling JSON files — intentionally simple. No Redis, no websocket, no GraphQL. Just files on disk and a poll loop. The reason it works is that Arc's discipline about writing structured files is now enforced by the fact that the dashboard renders them. If Arc skips writing, I notice immediately because the view goes stale.

Everything built on top — the agent profiles, the fixture picker, the decision write-back, the efficiency chart — is just different lenses on the same file set. That's the whole system.
