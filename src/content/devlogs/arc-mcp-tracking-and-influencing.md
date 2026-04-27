---
title: "Tracking and Influencing What I Can't Watch: The Visibility Stack for a Multi-Agent Build"
description: "How do I know what five concurrent agents are doing, when half of them are subagents inside other agents? A dashboard, a file watcher, a save-sync bridge, and an MCP server that finally enforced the contract — plus the OpenTelemetry investigation that surfaced an upstream gap."
pubDate: 2026-04-27T21:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["mcp", "observability", "agents", "opentelemetry", "dashboard", "architecture"]
draft: true
---

<!--
DRAFT NOTE — Arc-MCP / visibility-stack deep-dive (post 4 of 4 in MCP series).
Absorbs three prior posts (file-watcher-for-prod-sync, save-sync-without-a-backend,
dev-console-agent-dashboard) which can be deleted once this one is approved.

Series:
  1. Why build an MCP server? Why build three? (hub)
  2. Port-MCP — Godot / web-export
  3. Vera-MCP — Test infrastructure
  4. (this) Tracking and influencing what I can't watch — the Arc-MCP / visibility post
-->

At any given moment, my AI development stack might have four to seven agents working concurrently. There's Arc, the orchestrator I talk to directly. There's Nix (game systems), Vera (tests), Port (web export), each running long-lived in their own subprocess inside Arc's session. Each lead might have spawned two or three ephemeral workers — Explore agents, Plan agents, anonymous workers running specific tickets. The total count fluctuates by the minute.

I cannot watch them all. I can watch *one* — Arc, in my terminal — and the rest are happening somewhere I can't see.

The question that this post is about: *how do I track and influence what's happening when so much is automated?* It started as a dashboard. It ended up as a stack — a dashboard, a file watcher, a save-sync bridge, an OpenTelemetry investigation, and an MCP server that finally enforced the contract that ties them together. Each layer was built because the layer below it wasn't quite enough.

This is the fourth post in a four-part series on MCP. The [hub](/devlog/why-build-mcp-and-why-three/) frames when MCP earns its complexity and why I split one server into three. The [Port-MCP](#) and [Vera-MCP](/devlog/vera-mcp-test-infrastructure/) deep-dives cover the two domains that are public-OSS candidates. This one covers the third — Arc-MCP, the orchestration server — and the visibility stack it sits inside. It's the post that has the most going wrong; that's where the lessons are.

## What I needed to see

The agents were already producing structured output. Arc was writing six files to `ChroniclesOfNesis/tickets/`:

- `tickets.json` — every ticket with phase, leads, success criteria, subtasks, comments
- `epics.json` — epic groupings (Milestone → Epic → Ticket) with hour estimates
- `dashboard.json` — expert status and recent activity
- `agents.json` — expert definitions, owned docs, worker history
- `agent_chat.ndjson` — append-only chat log between leads (and to me)
- `agent_activity.json` — live "who's doing what right now"

Plus two from the test suite — `test_index.json` and `test_roadmap.json`.

The shape was right. The problem was access. The files lived on my dev machine. I wanted to read them from my phone over lunch. That's the real reason any of this exists.

## First layer: the dashboard

I built a dashboard. Not the "look at my project, investor" kind — the kind I actually use as a tool. The webapp at `/test/` polls those files every few seconds and renders live views.

Six tabs, ordered by how often I click them:

**Console** (landing). Sync status, version, milestone progress cards with weighted completion (done=100%, testing=75%, in_progress=50%), recent deployments. Everything above the fold for a morning check-in.

**Tickets**. The workhorse. Phase swim lanes across the top — Planning, Tech Review, Ready, In Progress, Testing, Done — each with three color-coded badges: green active epics, yellow epics waiting on me, grey total. Below the lanes, an epic-grouped ticket list filtered by the selected phase.

**Agents**. Per-agent status cards. Click an agent to pin their profile: every comment they've made across every ticket, reverse-chronological. If Nix said something three days ago about SL-4 and I want the context, it's two clicks.

**Tests**. The four-tier test tree (covered in detail in the [Vera-MCP post](/devlog/vera-mcp-test-infrastructure/)).

**Agent Chat**. A scrolling chat-style feed of every message between agents. Reads like a Slack channel where the participants are AI.

**Questions**. Where Arc asks *me* to decide things. This tab has the highest leverage by far.

The Questions tab works because Arc writes structured decisions to `agent_chat.ndjson`:

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

The Questions page renders these as cards. When I click a choice, the webapp POSTs to `/api/decisions`. A Vite middleware appends a new chat message marked `from: "AllByte"`, `status: "resolved"`. On Arc's next file poll, the decision is picked up and the ticket moves forward.

This replaces the terminal round-trip. A decision that used to take three minutes of "Arc describes the options, I pick, Arc updates the ticket" now takes about eight seconds of webapp clicking. More importantly, it's asynchronous. I can answer six decisions from my phone during lunch.

That's what I built first. It worked. For about a week.

## Second layer: getting the files to prod

The dashboard worked locally because a Vite proxy streams the files directly from disk. Prod was the problem. Two repos with two git identities:

- **ChroniclesOfNesis** — the game, private, pushed with my personal GitHub account.
- **allbyte-web** — this site, public, pushed with the `allbytestudios` account.

The game writes test results to `ChroniclesOfNesis/test_results/test_run_status.json`. The web app reads those files and paints a dashboard. In dev that's free. In prod they live at `s3://allbyte.studio-site/test-snapshot/`, uploaded by `scripts/push-assets.js` during a normal web deploy.

Which means: the only way to refresh prod test data was to push the web repo. Every time I ran tests on the game, prod stayed stale until I shipped the site again. Defeated the entire reason I'd built the dashboard.

Easy fix, right? Wrong. Every clean option broke on a different constraint.

**Git hook on the game repo.** A `post-commit` in Chronicles could push the three files straight to S3. But Chronicles' git config was tied to my personal identity, the AWS credentials on my machine were tied to the Allbyte account, and I did not want the game repo to know anything about the web app's bucket. Cross-contamination waiting to happen.

**Git hook on the web repo.** Can't — the trigger lives in the wrong repo. The web repo has no idea the game ran tests.

**A scheduled GitHub Action polling S3.** Runners can't see my laptop. The test files only exist on my local disk.

**A scheduled GitHub Action that runs the game's test suite in CI.** The game is a Godot project with a private asset pipeline. Setting up headless Godot in a GitHub runner for the sake of this is a week of yak-shaving for an afternoon problem.

**Cloud-side polling.** Same problem: nothing in the cloud can see my laptop.

**Just remember to run `npm run push-assets` after every test run.** I forget. Every time. And it syncs far more than I want.

What kept surviving the cut was a dumb, local, long-running daemon: watch the files, push to S3 on change, stay out of git entirely. So I built `scripts/sync-test-data-watcher.js`. Pure Node, no new dependencies. It:

1. `fs.watch`es the watched files.
2. Debounces changes with a 2-second window (atomic writes fire `change` + `rename`; one save shouldn't trigger two syncs).
3. Shells out to `aws s3 cp` / `aws s3 sync` to push to `test-snapshot/`.
4. Trips a circuit breaker after three consecutive failures and pauses uploads for 60 seconds so a dead VPN connection doesn't burn my request quota.
5. Writes a heartbeat file to S3 every 60 seconds so the dashboard can tell the watcher is alive.

That fifth one is the part worth talking about. The first four I had before I started; the fifth I added when the dashboard sat at "stale" for half a day before I noticed and the watcher had silently died after a network blip three hours earlier.

Daemons that do nothing are indistinguishable from daemons that are broken. The whole pitch of the watcher is "you don't have to think about it." Which means the failure mode is "you stopped thinking about it and it stopped working." So along with every successful sync, the watcher uploads `test-snapshot/heartbeat.json`:

```json
{
  "schema_version": 1,
  "written_at": "2026-04-11T22:44:00Z",
  "started_at": "2026-04-11T18:00:00Z",
  "last_sync_at": "2026-04-11T22:43:58Z",
  "last_sync_ok": true,
  "consecutive_failures": 0,
  "host": "drew-desktop",
  "pid": 12872
}
```

It refreshes every 60 seconds regardless of whether files changed. "No tests ran in the last hour" is still observable — an idle, living watcher keeps stamping a fresh `written_at`. The dashboard fetches `heartbeat.json` and renders a status pill: cyan-pulsing live (under 3min), amber stale (under 10min), red offline (older or missing). A red banner drops in above the columns when it goes amber or red, because a corner pill is easy to miss.

There's a whole class of problems that look distributed but are really "I have one computer and I want it to do something." Git hooks, CI runners, cloud schedulers, pub/sub buses — they all feel like the right shape because the problem *feels* like integration between systems. But when the data never leaves my laptop in the first place, a long-running local process is the right answer, and the only real engineering is making sure it doesn't die without telling you. The heartbeat is the whole trick. Everything else is plumbing.

## Third layer: the back-channel from inside the game

The dashboard reads state. The watcher delivers state to prod. Both flows are one-directional.

Then I needed a *bidirectional* channel — specifically, the game (running in a browser iframe) had to push state to the parent webapp, and the parent webapp had to push state back to the game. Save sync was the first concrete need. The same pattern ended up being the answer for `/api/decisions` writes back to Arc.

The Chronicles save system is six (now twelve) manual save slots, each storing party state, equipment, quest progress, treasure flags, and scene location. On desktop builds, those slots live in a SQLite database. On the web build, they live in browser `localStorage`. Fine until the player switches devices. Or clears their browser. Or wants to share a save.

The constraint I gave myself: the in-game "Save" action must remain the only save the user ever has to think about. No "save to cloud" button. No "export to file" prompt every session. The game saves; everything else is invisible.

The shape that landed:

```
┌─────────────────────────────────────────────────┐
│  Layer 0: in-memory _all_saves[slotId]          │  ← what the game uses while running
├─────────────────────────────────────────────────┤
│  Layer 1: localStorage (con_nesis_save_N)       │  ← THE SAVE. Source of truth on the device.
├─────────────────────────────────────────────────┤
│  Layer 2: postMessage to parent web app         │  ← bridge to the host page (everyone)
│              ├── Manual file export / import    │  ← user-driven escape hatch (everyone)
│              └── Server upload                  │  ← cloud backup (Hero/Legend only)
├─────────────────────────────────────────────────┤
│  Layer 3: DynamoDB on the server                │  ← persistent cloud copy (Hero/Legend)
└─────────────────────────────────────────────────┘
```

The save is **considered successful when Layer 1 succeeds.** Layer 2 and Layer 3 are bonuses. If postMessage fails, log a warning and queue it for retry — do NOT roll back the localStorage write, and do NOT report a save failure to the player.

That separation is the most important architectural commitment in the whole feature. It's the thing that makes everything else simple. If the save flow had to wait for cloud confirmation before declaring success, every layer would have to handle every failure mode of every layer below it. By making each layer independently authoritative for its own scope, I get a system where Layer 1 is bulletproof, Layer 2 has graceful degradation, and Layer 3 is opt-in.

Layer 2 (postMessage) is the part that turned out to generalize. The Astro web app hosts the game in an iframe. The game posts:

```js
{
  type: 'allbyte:save-changed',
  slotId: 1,
  data: '{"version":1,"timestamp":1712760000,...}'
}
```

The web app listens with a window message handler and stashes the data in its own in-memory cache. If the user has Hero or Legend tier, a debounced server upload fires 5 seconds after the last save (so a flurry of rapid saves only triggers one network call).

The protocol is small: `allbyte:ready`, `allbyte:save-changed`, `allbyte:all-saves`, `allbyte:request-saves`, `allbyte:load-saves`, `allbyte:load-complete`. Plus an ordering rule: the parent must NOT send `request-saves` or `load-saves` until it has received `ready`. If the parent injects saves before the game has finished loading, the game's in-memory state isn't authoritative yet and the load gets stomped. A small queue on the web side enforces this.

Why I'm telling you about save sync in a post about agent visibility: the same pattern — a structured async channel between two surfaces that don't share memory — is what `/api/decisions` does. Owner clicks a Question card → web app POSTs to a Vite middleware → middleware appends to `owner_answers.ndjson` → Arc's daemon reads `owner_answers.ndjson` → Arc routes the answer to the worker that asked. Different domain, same shape: file-based bridge with explicit ordering, single-writer per direction, graceful degradation.

By the time I'd built save sync, the bidirectional pattern was a load-bearing primitive of the visibility stack. Read state via files, write decisions via files, ordering by timestamp, no shared memory.

## The cracks: bookkeeping fragility

The dashboard worked. The watcher worked. The bridge worked. I had a system where I could see what my agents were doing, and answer their questions from my phone over lunch. The blog post you're reading is partly about the gap between *that sentence* and the actual experience.

The gap was bookkeeping.

`agent_activity.json` is meant to answer "what's running right now." Arc updates it on every spawn, every status change, every completion. Every entry has a `status` field. The dashboard filters to `status === "working"` and renders cards.

What I noticed, six weeks in: Arc was great at writing the spawn entry. Less great at writing the completion entry. Specific entries kept lingering as `status: "working"` long after the agent had finished. Some were two days old. Some were *thirteen* days old. The dashboard was showing six "working" agents when only two were actually running.

I'd built a dashboard that was honest about a file. The file was wrong.

The first patch was a wall-clock heuristic. Any entry that had been "working" for more than an hour got a cautionary amber border. More than four hours, red. It worked the way you'd expect a band-aid to work: the most egregious staleness became visible, and the rest stayed invisible.

The right fix was different. It was a contract.

## The OTel detour

Before I got to the contract, I went down a rabbit hole that turned out to be informative for the wrong reasons.

Claude Code emits OpenTelemetry traces. Every Agent-tool invocation has a `claude_code.tool` span. Every interaction has a `claude_code.interaction` root. Every span carries a `session.id`. If I could stand up a Tempo + Grafana stack pointed at the dev container, I'd have a *real* answer to "is this agent alive right now" — pulled from the running process, not from Arc's bookkeeping.

I built it. Tempo + Grafana running in Docker alongside the dev containers, OTel env vars wired through to Claude Code, a new tab at `/test/in-flight/` that queried Tempo for live sessions and rendered them as cards. Spans flowed. Cards rendered. For about an hour I thought I'd solved the problem.

Then I noticed something: the dashboard showed *one* live session, but I knew Arc had spawned three subagents (Nix on a menu fix, Vera on a test scaffold, Port on a redeploy). The session count should have been four — Arc plus three subagents. It was one.

I dumped every attribute key Claude Code emits across all the spans in a real trace. The full inventory:

```
attempt              cache_creation_tokens   cache_read_tokens
client_request_id    decision                duration_ms
file_path            full_command            gen_ai.request.model
gen_ai.response.id   gen_ai.system           input_tokens
interaction.duration_ms     interaction.sequence
llm_request.context  model                   organization.id
output_tokens        request_id              session.id
source               span.type               speed
success              terminal.type           tool_name
ttft_ms              user.account_id         user.account_uuid
user.email           user.id                 user_prompt    user_prompt_length
```

No `subagent_type`. No `agent_role`. No `parent_invocation_id`. Nothing.

When Claude Code spawns a subagent via the Agent (Task) tool, the subagent runs in-process and inherits the parent's `session.id`. Every span the subagent emits carries the parent's `session.id` and no per-subagent identifier. From OTel's perspective, "Arc spawned Nix and Vera and Port concurrently" is **structurally indistinguishable** from "Arc did everything itself."

OTel reflects PROCESS reality, not PERSONA reality. It can tell me a Claude Code process is alive. It cannot tell me which agent persona inside that process is doing what.

I filed a feature request to anthropic/claude-code asking for `claude_code.subagent_type` and `claude_code.subagent_invocation_id` as span attributes. Until that lands (or doesn't), OTel is a process-level signal, not a per-subagent one. The visibility stack has to use it that way.

The detour wasn't wasted. Tempo is still load-bearing as a *cross-check*. If `agent_activity.json` says Arc's session is alive but Tempo hasn't seen a span from that session in 60 seconds, that's a real anomaly worth flagging. The corroboration signal is real. It just operates at the granularity OTel ships, which is "the process emitted recently" — not "Nix specifically emitted recently."

## The contract: agent_activity_op

The right fix for bookkeeping fragility was the same kind of fix the rest of the stack already had: stop trusting that every site that touches the file remembers to do the right thing. Centralize the discipline.

`agent_activity_op` is the MCP tool inside [arc-mcp](/devlog/why-build-mcp-and-why-three/) that owns every write to `agent_activity.json`. Six operations:

- `add` — new entry, `status: "working"`. Auto-fills `session_id` from the writer's Claude Code OTel session. Auto-derives `epic` from the entry's tickets.
- `update` — mutate fields in place (non-terminal).
- `complete` — flip status to `completed` AND **move the entry from `activeAgents[]` to `recentActivity[]`** (capped at 50, oldest evicted).
- `mark_lost` — same move-and-flip but with `status: "lost"` and no result summary, for stalled-out sessions.
- `sweep_stale` — cron sweep using OTel: any `working` entry whose `session_id` has had no Tempo span in last 5 minutes gets `mark_lost`'d.
- `read_active` — read-only convenience.

The critical piece is the *move* in `complete` / `mark_lost`. Before this tool, "completion" was just a status flip — entries stayed in `activeAgents[]` forever. After: completion is structurally a move out of the active list. Active = active by structure, not by filter. Completed = retrievable from `recentActivity[]`, capped, doesn't grow unbounded. Stale = never present (the sweep moves them out within minutes).

The schema added a few fields beyond what was already there:

```json
{
  "agent": "Nix",
  "agent_id": "ab12345...",          // Agent tool's returned id
  "task": "Fix MENU-NAV skip-walker bug",
  "tickets": ["MENU-NAV"],
  "epic": "MENU-NAVIGATION",          // auto-derived; "MULTI" if cross-epic
  "session_id": "uuid",               // for OTel correlation
  "status": "working",

  "worker_status": "investigating_root_cause",   // granular phase
  "progress_pct": 30,
  "eta_seconds": 600,
  "eta_updated_at": "...",
  "active_question": null,            // null OR { question_id, text, urgency }
  "blockers": [],

  "started": "...",
  "subagents": { ... }
}
```

All the new fields are optional. Legacy entries render fine with the old two-line baseline.

The architecture is layered. Layer 1 is Arc-driven lifecycle — `add` on every spawn, `complete` or `mark_lost` on every task-notification. Definitive, terminal. Layer 2 is worker self-reporting — workers call `update`, `report_progress`, `report_question`, `report_blocker` for richer state. Layer 3 is the `sweep_stale` backstop, using OTel as the cross-check oracle. If Layer 1 is reliable, Layer 3 should be a no-op in normal operation.

This is the contract that finally pulled the visibility stack together.

## What works now

The dashboard reads `agent_activity.json` via Server-Sent Events. The Vite dev server's file-watcher pushes change events to the browser within ~200ms of Arc's writes. Polling stays as a fallback for SSE drops and for prod (which has no SSE). Latency dropped from "every 2 seconds" to "as fast as the file-watcher fires" in dev.

Cards render `agent_activity` content as the source of truth. OTel corroboration shows up as a secondary signal — a small corner indicator (✓ corroborated, ⚠ quiet 10–60s, 🚨 stale >60s, ◯ unverified for entries without `session_id`) and a rollup pill in the section header. The corroboration isn't gating render; it's *flagging discrepancies* between what the file claims and what OTel observes. When entries start carrying `session_id` (mid-rollout as of this writing), the rollup will show mostly green; before then, mostly grey.

Lifecycle enforcement via the MCP tool eliminates the 13-day stale entries by construction. Completed and lost entries don't sit around — they move. The active list size is bounded; `recentActivity[]` is capped at 50.

The decision write-back path still works, with the same shape it always had. Owner clicks a Question card → `/api/decisions` middleware appends to `owner_answers.ndjson` → Arc's daemon picks it up → ticket moves forward. The bridge is the bridge.

## What's still experimental

The dashboard concept itself isn't fully landed. Honestly: Arc's terminal still wins for in-flight awareness. When I want to know "what is Nix doing *right now*," I look at the terminal scroll, not the dashboard. The dashboard wins for state-summary — sprint progress, ticket counts, what's blocked, who's waiting on a decision. The two surfaces answer different questions, and trying to make a polling-based dashboard substitute for an event-stream terminal is the failure mode.

Per-subagent attribution waits on Anthropic upstream. If they ship `claude_code.subagent_type` as a span attribute, the dashboard could distinguish Nix from Vera from Port within Arc's session — today it can't, because the OTel data doesn't carry the persona.

The reporting extensions (`report_progress`, `report_question`, `report_blocker`) are implemented but not yet propagated through worker-prompt boilerplate. As workers cycle and the new ops get adopted, the dashboard's progress bars and ETA tooltips will start lighting up. Right now they're conditional render code waiting for fields to exist.

## Lessons

A few things that are now load-bearing in how I think about this:

**File-based realtime is enough — if you commit to the SLA and enforce it via MCP.** The whole stack is files: tickets, epics, agent_activity, agent_chat, owner_answers. Polling and SSE deliver the contents. The SLA is "≤5s between event and dashboard render," and it holds because Arc's writes go through `agent_activity_op`, which can't NOT update the file atomically. The file-based approach gets a bad rap for being old-fashioned; what actually makes it fragile is letting every site that touches it implement its own write semantics. Centralize that in one tool and the file becomes a perfectly fine substrate.

**OTel reflects process reality, not persona reality.** A real limitation that I didn't fully appreciate until I'd built the in-flight view and it showed one session for what I knew were three subagents. Filed upstream; expect to live with the gap for a while. Until then, OTel is a *cross-check* signal, not a per-persona one.

**MCP is the right enforcement point for "everyone writes the same shape."** Schema validation, atomic locking, lifecycle move semantics — all the stuff that's tedious to remember at every callsite — lives in the tool, gets called the same way every time. The agent's job is to call it; the tool's job is to be right.

**Dashboards are good at state-summary. Terminal streams are good at live awareness. Don't try to substitute one for the other.** This took me longer to internalize than it should have. The dashboard at /test/ is great for "where are we?" It's not great for "what is Nix doing in this exact moment?" Arc's terminal is great for the second question — and it's already there. I stopped trying to make the dashboard win that fight.

**Schema additions are cheap if they're optional and additive.** All of `agent_id`, `worker_status`, `progress_pct`, `eta_seconds`, `active_question`, `blockers` shipped without breaking anything. Legacy entries render fine. Migrating entries render with more detail. New entries render with the full picture. Optional fields are an underused tool for shipping evolution without rewrites.

**The heartbeat pattern is the whole trick for daemons.** A long-running process that keeps stamping `written_at` on a heartbeat file is observable in a way one that just runs is not. The dashboard that can tell you "the watcher is alive but idle" is dramatically more useful than the dashboard that can only tell you "the data hasn't changed in a while."

## Closing

The visibility stack is dashboard-plus-watcher-plus-bridge-plus-MCP. None of those layers, alone, would have answered the question "what are my agents doing right now" well enough to use as a working tool. Together, with the contract that `agent_activity_op` enforces, they're starting to.

The dashboard concept is still an experiment in the sense that I'm not sure the right shape exists yet. The view I want — "live agent table, per-persona, refreshing as work happens" — is partly bottlenecked on the upstream Anthropic feature that would let me distinguish personas in OTel. Until that lands, the dashboard is honest about what it can and can't show, and Arc's terminal carries the load it can't.

Trace this whole arc back and the question that started it was the same the whole way: *how do I know what they're doing, and how do I influence it without interrupting the loop?* Answer, three layers in: the file system, an MCP-enforced contract, and a few minutes of clicking from my phone over lunch.
