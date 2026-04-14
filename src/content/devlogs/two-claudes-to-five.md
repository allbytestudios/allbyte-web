---
title: "From 2 Claudes to 5: The Whole Engineering Team"
description: "My engineering team went from two Claudes to five. How I split my game development Claude into 4 specialist leads — each with strict domain boundaries, context inheritance, and the ability to spin up ephemeral subagents for parallel work. Here's how the team actually coordinates."
pubDate: 2026-04-14T12:00:00Z
category: "workflow"
devlog: "studio"
tags: ["claude", "agents", "subagents", "ai-pair-programming", "workflow"]
draft: true
---

A few weeks ago my engineering team was two Claudes. [App Claude](/devlog/two-claudes-talking/) drove the web portal you're reading this on; CON Claude drove the Godot game. They coordinated through markdown files and a shared tmux session, which worked for small-scoped back-and-forth but buckled the moment either side had a queue longer than three items. One Claude thrashing on five parallel tasks still has only one context to think with.

It became clear when I was playtesting the game and listing bugs, new features, and odd behavior all to Claude at once. He literally said "wait, slow down" — because he was doing all the work. Testing the game, developing against my bug reports, talking to me about priority, documenting findings. One context doing four jobs. That's when it clicked: I needed specialists.

The shape I was reaching for was the one I'd spent my career inside of. Strong engineering teams run on experts in their own region — a data scientist, a DevOps engineer, a backend developer, a test engineer — plus a light hierarchy to govern decision-making: a technical lead who understands all the domains enough to route work, and someone (owner, product, me) defining priority. Each person owns their specialty. Nobody is asked to context-switch across everything simultaneously.

So I started discussing with Claude what experts we actually needed on this project. A **tester** was obvious — the Playwright+GUT test suite had grown to the point where it deserved a dedicated voice that wouldn't be tempted to skip a case. **Gamedev** (the GDScript lead) was obvious too — scene ports, event logic, and runtime bugs are a distinct domain from everything else. A **web-export specialist** wasn't on my initial list, but after weeks of deep debugging WASM hangs, shader quirks, pack-loading races, and Godot→HTML5 translation rules, I had a decent repository of web-export complications. That was clearly its own expertise; the context required to debug a WASM freeze is not the same context required to write a save/load test.

The fourth lead I wasn't sure about. A dedicated Claude just for talking to *me*? It felt indulgent until a few iterations in. Responsibilities stacked up quickly — ticket grooming, cross-lead coordination, resource allocation, priority calls, deciding what shippable looked like this week. Getting everything out of my head into the computer turned out to be a heavy task. It's always been a heavy task. Agile, Jira, Scrum, Kanban, tickets, standups — these are all elaborate mechanisms humans built to solve exactly one problem: getting an idea from one person's head into another's. I needed that mechanism here too. An orchestrator, an owner-interface. A technical lead who could hold the plan, translate my playtesting hand-waves into scoped tickets, and enforce the quality gates that keep the other leads from shipping half-baked work.

So: **Arc** (orchestrator) + **Nix** (gamedev) + **Vera** (tester) + **Port** (web-export). Four leads. Under them, as much parallel subagent work as a session can sustain. The fix wasn't a bigger model. It was more Claudes, each narrower.

Today the team is five:

- **App Claude** (me, writing this) — still drives the web portal, backend Lambdas, and the webapp dashboard. Unchanged.
- **Arc** — took CON Claude's seat as the orchestrator. Runs the ticket board, allocates work, gate-keeps Tech Review, signs off at Done.
- **Nix** — game system specialist. Owns GDScript, events, scene transitions, the lock state machine.
- **Vera** — test implementation specialist. Writes Playwright and GUT tests. Quality gate for requirements.
- **Port** — web export specialist. Owns WASM debugging, pack builds, translation rules for Godot→HTML5.

Arc manages Nix, Vera, and Port — same Claude Code instances under the hood, but each with strict domain boundaries, different files visible, and no permission to edit each other's territory. That last part is the most important one.

On top of the five named leads, any lead can **spin up ephemeral subagents** (Claude Code worker threads) for parallel work — writing a batch of tests, auditing dependencies, refactoring a file — with isolated git worktrees so their changes stay quarantined until a lead cherry-picks them. The five leads are the permanent team; the subagents are short-term contractors who show up for one task and leave.

## The observation that started it

I hit the same wall every session. The main thread would spend ten minutes on a coordinated task — a scene port needing a pack rebuild, a fade bug needing re-exports between attempts — and while I was waiting for Godot to finish or the browser to load, nothing else was happening. Meanwhile a dozen independently-scoped items sat in the backlog: tests for a code area that had none, a dep audit for the upcoming pack, documentation for the framework I'd just built, a one-file refactor I'd been putting off.

Zero subagents was leaving capacity on the floor.

The standing rule became: **ideally two subagents working at all times**. Every response the main thread gave that involved non-trivial work had to answer one question first — "is there a parallel task I can delegate?" If yes, the agent spun before the main-thread work started, so both progressed at once.

The throughput jumped immediately. The bottleneck story changed too: sessions stopped *stalling*. If the main thread was waiting 90 seconds for a pack rebuild, the subagent was writing tests. If the subagent was stuck exploring a new file, the main thread was debugging a browser issue. Context-switching between these streams costs maybe ten seconds each; the savings from running them in parallel dwarf the switch cost.

But just running more agents wasn't enough.

## The subagent playbook

Multi-agent work collapses the moment the agents step on each other. I lost a full afternoon to three agents all editing `TestBridge.gd` in parallel — each one did correct work in isolation, and when I tried to cherry-pick all three the overlapping edits conflicted at the dispatch site. I hand-merged it, swore, and wrote down the rule:

**TestBridge.gd is main-thread-owned.** So are `DialogueHandler.gd`, `World.gd`, and `SceneTemplate.gd` — the cross-cutting autoloads every test and every scene touches. If I need three different hook sets added, I write them myself in sequence. Not in parallel.

The other rules fell into place around that first one:

**Good delegation targets** — independent, deterministic, independently verifiable:
- Tier 1 unit tests for a new code area
- Playwright coverage for one event command type
- Documentation and roadmap writes (pure reads)
- Dependency audits ("what sprites does MainSquare reference that aren't in the pack yet?")
- One-file refactors

**Bad delegation targets** — coordination-heavy or shared-resource:
- Scene ports that need pack rebuilds (`godot --export-pack` is single-threaded against the output file; two agents race)
- Edits to cross-cutting autoloads
- Debug loops that require iterating against live game state (the round-trip cost of re-running the experiment myself eats any savings)
- Anything needing the same external tool

The debugging lesson hurt the most to learn. I delegated a failing test once — "figure out why `test_church_square_entry_event` fails, fix it, verify green." The agent got twenty percent of the way through, hit a sub-second timing issue it couldn't diagnose without me running the browser for it, and stopped with a 400-word report of "I think it's one of these three things." Useless. I had to redo the investigation to ground-truth. **Don't delegate anything that requires iterating against live state.**

## Worktree isolation

Every subagent spawns with `isolation: "worktree"` — Claude Code creates a fresh git worktree at `.claude/worktrees/agent-<id>/`. The agent only sees that worktree, can only edit files under it, and its changes never touch the main checkout until I cherry-pick them.

This is the mechanism that makes parallel agent work safe. Two agents can be editing the same file path and neither sees the other's edits until I merge. The cherry-pick is deliberately low-tech:

```
cp .claude/worktrees/agent-X/path/to/file path/to/file
git add path/to/file
DISPLAY=:99 timeout 60 python3 -m pytest path/to/test -v
git commit -m "..."
```

No merge. No rebase. Just `cp` followed by a verification command and a commit. That file-by-file control is what stops the parallel work from piling into merge conflicts at the dispatch site.

The agent never gets to commit. Every briefing prompt includes "do not commit" explicitly — agents sometimes commit in their worktree thinking it helps, but it doesn't, because I can't cherry-pick from a branch, I can only copy files.

## The 300-500 word briefing floor (tickets all the way down)

The single biggest lesson from the first few parallel sessions: **one-line agent prompts produce bad work.**

That lesson applies at every level of the hierarchy. When Arc briefs Nix on a ticket, the same rules apply. When Nix spawns a subagent to write tests, the same rules again. An agent arriving with zero context has to infer the scope, the files to avoid, the verification strategy, and the deliverable format. Without a proper brief, it does the obvious thing — which is usually not what anyone wanted — and then someone upstream spends fifteen minutes translating its output into something usable. By then they could have done the task themselves.

The shape settled on 300-500 words per brief. That wasn't a guess — Arc and I iterated on what a ticket should look like, and I basically replicated how I've built tickets in my career before this. Good tickets have always needed the same things: why the work matters, scope boundaries, technical context, what "done" looks like. Humans don't usually struggle with ticket size (we tend to write just enough to do the work). Claude is more at risk of both under-and over-scoping — hence the explicit floor and the explicit ceiling.

A well-formed brief includes six things:

1. **What the agent is doing and why** — not "write tests for the dialogue system," but "the owner wants every event command type to have coverage. You're taking a slice: `delay`, `face`, `faceCharacter`, `position`, `speed`, `visibility`. The goal is to catch regressions in `SceneTemplate.gd`'s command-match statement if someone reorders or breaks an arm."

2. **Strict scope fences** — which files may be edited, which may only be read, which are hands-off. For test agents I typically list: "Edit: `WebTests/test_<thing>.py` (new file only). Read only: `WebBootstrap/Autoload/TestBridge.gd`, `SceneTemplate.gd`, `core_Events.json`. Hands-off: anything in `packs_src/`, any other `WebTests/*.py`."

3. **Files to read first, in order** — saves the agent five to ten minutes of exploration and makes sure it hits the source of truth before the derived docs.

4. **Concrete deliverable format** — "A report under 300 words with: list of files touched, test function names grouped by bucket, any surprising behaviour you found with `file:line` citations, the exact `pytest -k` command to run just your tests, and whether your tests pass headless."

5. **Do not commit** — repeated every brief. Agents forget.

6. **Time budget** — 30-45 minutes typical, 60-90 for larger refactors. The agent uses this to decide how much exploration is acceptable before starting the actual write.

The report shape is load-bearing. Whoever sent the brief uses the file list for cherry-picking and the verification command to confirm the agent's claims before trusting the output. The work doesn't cross the worktree boundary until verification passes.

## Pushback, questions, and the terminal overflow

The briefing floor works — when I've actually met it. In practice I don't always. My playtesting descriptions are hand-wavy. I skip technical details I assume are obvious. I leave UI decisions ambiguous because I haven't made them yet.

So I built in two mechanisms with Arc.

**Arc pushes back on me.** If my ticket description is too vague, if a technical detail isn't specified, if there's an implicit UI decision I haven't called out — Arc asks before the ticket goes anywhere. Tech Review is the formal gate, but the pushback starts earlier, in the conversation where I'm still dictating the idea. The goal is that every ticket leaving my terminal has everything a lead needs, no follow-up questions required.

**Leads can surface questions back to me.** We won't get requirements right every time — that's fine. When Nix hits a missing criterion, or Vera realizes the test specs are ambiguous, they raise the question in their ticket comment. Arc aggregates those into a queue for me.

That last mechanism broke my terminal almost immediately. I'd be three pages deep in a conversation with Arc about one feature's scope when Nix raised three concerns about a different ticket, Vera flagged missing tests on a third, and Port asked about pack-build timing on a fourth. My original Arc conversation was now five pages up in the scrollback. I was context-switching constantly just to read the latest updates, and half the time I missed them entirely.

Since we have Claude, we can just build what we need. So I designed a ticketing system:

- **Arc writes the state** — every ticket, every phase transition, every lead signoff — to JSON files. Cross-agent chat goes to a separate NDJSON stream. Decisions pointed at me go to a dedicated channel.
- **App Claude built the webapp side** — reads those files and renders them live. I see ticket state, lead status, and agent chat in visually separated places instead of one scrolling terminal.
- **The decision queue** is the key piece — a curated list of specific questions with pre-framed options. When I have ten minutes, I can run through five unblocks instead of hunting them across three Claude sessions.

That webapp — the **Dev Console** — became the thing that actually unblocks day-to-day work. Without it I was the bottleneck, missing lead questions for hours because they'd scrolled off the top of my terminal. With it I can glance at the Questions tab and clear six pending decisions in a coffee break. **[A Real-Time Dashboard for an AI Development Team](/devlog/dev-console-agent-dashboard/)** walks through how the dashboard is built — the data contract, the tabs, the decision write-back loop, and how App Claude contributes its own recommendations when Arc asks the backend for input. That post is the *how*; this one is the *why*.

I'm still training Arc to route lead updates through the ticket system instead of dumping them into our conversation. Occasionally he slips and I get a lead's status report mid-dialogue about something else. That'll improve — or at some point I'll just add a rule to his CLAUDE.md forbidding it.

## Context inheritance: why named specialists work

The four-agent team didn't work well until I changed how context loaded.

Originally every agent started cold. I had a `.claude/agent_prompts/game_expert.md`, `test_expert.md`, etc. — manually pasted in when I spawned each agent. Agents didn't share universal rules, didn't know about each other's domains, and couldn't push back when I gave them incomplete requirements. The briefing quality varied session to session based on whether I remembered to load the right prompt.

The fix was embarrassingly simple: Claude Code already loads `CLAUDE.md` files hierarchically by directory. Restructuring around that gave every agent an automatic context inheritance chain:

```
/workspace/GameDev/CLAUDE.md              ← Arc (orchestrator, universal rules)
  └── ChroniclesOfNesis/CLAUDE.md         ← Nix (game system)
        ├── WebTests/CLAUDE.md            ← Vera (test implementation)
        └── WebBootstrap/CLAUDE.md        ← Port (web export)
```

An agent working in `WebTests/` automatically gets: universal rules → game context → test specifics. No manual prompt injection. No context forgotten. The chain means a test agent knows both the Claude-side universal rules *and* the game-side domain constraints — simultaneously, automatically, every spawn.

The names (Arc, Nix, Vera, Port) are three-letter handles that compress quickly in conversation. "Arc, cut me a ticket for the menu bug" is faster than "orchestrator, cut me a ticket." The shortness matters when you're describing agent coordination in flight.

## Cross-agent awareness without cross-agent editing

Each lead knows enough about siblings to **recognize boundaries and hand off**, not enough to do the other's job.

- Nix knows every bug fix needs a regression test — but doesn't write tests. Flags to Vera.
- Vera knows silent browser hangs are WASM issues — but doesn't debug them. Flags to Port.
- Port knows scene porting needs autoload dependency checks — but doesn't investigate game logic. Flags to Nix.

This was the unlock. Before, when I'd ask an agent to fix a bug it would often go write the test itself — or skip the test entirely. Now the boundary is explicit in each agent's CLAUDE.md: "your job is X, for Y you raise it to Arc." The loop back through Arc is a few seconds of overhead and prevents the thousand-line scope-creep output.

## Session-end protocol

The rule that makes all of this survive across sessions: **every lead session must end by updating the ticket.** What was done, what's left, blockers discovered, files touched. This is what makes the next cold-start fast. A lead spawning tomorrow morning doesn't re-discover state — they read the ticket, load the linked files, and continue.

This ticket discipline is the subject of a separate post. It's the backbone of the async workflow I'm building toward — where I spend a short block of time with Arc every day, define requirements, sign off during Tech Review, and then let leads work through the queue for the next 24 hours between my check-ins.

## What the scaffolding actually enables

The obvious win is throughput. Session 11 ran two-agent parallelism consistently and the commit graph shows it: four-ish commits per hour, each one either a ported scene, a bug fix, a new test suite, or infrastructure. Zero bottlenecks on agent returns.

The less obvious win is that specialists stay specialists. Nix doesn't get bogged down in test architecture. Vera doesn't get dragged into GDScript details. Port doesn't debate success criteria. Each lead does the thing they're best at, and when the boundary is reached they hand off — cleanly, explicitly, traceably in the ticket.

And the really non-obvious win: failure modes become legible. When an agent produces a bad output, I can usually trace it to one of six failures: scope too large, briefing too vague, wrong specialist picked, context file missing a key rule, task was debug-loop disguised as a delegable task, or the forbidden-files list was incomplete. All six are fixable with documentation.

The system is still young. The real test is whether the async workflow holds up over weeks — whether I can go offline for a day and come back to real forward progress rather than thrashed context. That's being validated now.

But the shape is clear. A single Claude was a capable solo developer. Arc, Nix, Vera, and Port are a specialist team, and the whole is already doing more than the parts.

The work lives in the repo. The infrastructure — ticket system, webapp dashboard, efficiency tracking — gets its own posts. This one was about the agents.
