---
title: "I Surveyed Eight Godot MCP Servers and Built My Own"
description: "My agents have been building bash heredocs to update tickets, parsing pytest stdout by regex, and shell-quoting live-mutation JSON for months. MCP is the right shape for all of it — but the right server wasn't on GitHub."
pubDate: 2026-04-26T22:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["mcp", "agents", "godot", "tooling", "process"]
draft: true
---

<!--
DRAFT NOTE — do not promote until at least one allbyte-mcp tool ships end-to-end
(target: Stage 2 ticket_op or redeploy). Currently Stage 1 is scaffolding-only;
publishing now would be "we planned a thing." Wait for a working before/after
measurement to anchor section "What changed once a tool actually shipped."

Specific TODOs marked inline.
-->

A typical day in my agent stack involves about thirty ticket updates. Each one looks like this:

```bash
flock /workspace/GameDev/ChroniclesOfNesis/tickets/tickets.json.lock python3 << 'PYEOF'
import json
from datetime import datetime, timezone

PATH = '/workspace/GameDev/ChroniclesOfNesis/tickets/tickets.json'
with open(PATH) as f:
    d = json.load(f)

found = False
for t in d['tickets']:
    if t['id'] == 'EVT5-HANG':
        t['phase'] = 'testing'
        t['lastUpdate'] = datetime.now(timezone.utc).isoformat() + ' — fixed via Rule-4 cache'
        found = True
        break

if not found:
    raise SystemExit(f'Ticket EVT5-HANG not found')

with open(PATH, 'w') as f:
    json.dump(d, f, indent=2)
print('OK')
PYEOF
```

Twenty-five lines of heredoc to set one field on one ticket. Repeated thirty-plus times per session, by an LLM agent that has to construct it correctly every time, parse the trailing `OK`, and translate any Python traceback into a ticket-system error. The `flock` is non-negotiable — multiple agents touch this file — but the heredoc preamble is pure overhead.

It gets worse. To run a Playwright test, my agents shell out to `pytest`, capture stdout, regex-scan for `PASSED` / `FAILED` markers, and dig screenshot paths out of tracebacks. To do a live mutation against the running WASM build during visual tuning, they call a custom `live_mutate.sh` script and shell-quote a JSON payload (`'[0.2, 0.2]'` — the outer quotes are critical and easy to lose). To redeploy after a fix, they invoke a 239-line bash script and grep its stdout for the deployed version. Every operation is some variation on *construct a string, run it, parse the response, hope the regex held*.

This is the exact problem [Model Context Protocol](https://modelcontextprotocol.io) was built to solve.

## What MCP changes

MCP is a small spec — a JSON-RPC dialect for letting an LLM call typed tools. Each tool has an input schema, a structured response, and a clean error path. From the agent's side, it's the difference between:

```bash
bash tools/redeploy_web.sh 2>&1 | tail -50  # then regex-parse for "Deployed v0.6.123"
```

and:

```
redeploy({})
→ { ok: true, version: "0.6.124", duration_ms: 8420, index_pck_bytes: 3214567, ... }
```

The token savings per call are small — maybe thirty to a hundred tokens. Across a thirty-call session it adds up to a few thousand. That's nice but it's not the headline. **The headline is reliability.** Agents get to act on structured fields instead of guessing whether their regex caught the right line in unusually-chatty stdout.

So I went looking for a Godot MCP server to adopt.

## The survey — eight candidates, one weekend

What followed was an exercise in research-agent humility.

My first sweep enumerated five candidates: `Coding-Solo/godot-mcp` (3,259 stars), `Sods2/godot-mcp` (new, feature-rich), `tomyud1/godot-mcp` (runtime-control philosophy match), `ee0pdt/Godot-MCP` (542 stars, stale), and `youichi-uda/godot-mcp-pro` (paid, $5). The agent's recommendation came back in four minutes: *adopt Sods2*.

I pushed back: *did you review these?* and pasted three more URLs.

This kept happening. The final candidate count was eight — `elfensky`, `MhrnMhrn`, `Nihilantropy`, and `Rufaty` were all repos my agent's GitHub search hadn't surfaced, because young ecosystems (Godot 4 MCP is about a year old; every candidate is Q1–Q2 2026) don't promote evenly. Stars and forum posts are the discovery surface, and most of the interesting work hadn't promoted itself yet.

By the time eight evals were complete, the recommendation had reversed. The technical winner was `elfensky/godot-mcp` (Chain-of-Responsibility command processor, path-traversal hardening, sixteen tests). The adoption winner was `tomyud1/godot-mcp` (260 stars, weekly cadence, external PRs landing). The original four-minute recommendation had been *fine* — but anchored on the first repo evaluated, made on incomplete data, and would have committed me to second-best.

There's a lesson in that worth pulling out: **when a research agent finishes a young-ecosystem survey in four minutes, the answer is probably wrong, even if it's defensible**. Owner domain knowledge is genuinely necessary to triple the candidate set. The agent did fine work on the candidates it had; it just didn't have all of them.

## Why I picked none of them

After eight evals, I built my own anyway.

The reasoning is unsatisfying because it's not "they're all bad" — several are genuinely good. It's that the shape of what I needed didn't match what any of them ships:

- **Tool list mismatch.** `tomyud1` ships forty-seven editor tools, mostly 3D and animation and particles. I run a 2D web export. Adopting means installing forty-something tools I'll never call so I can use the five I want.
- **TestBridge already exists.** The runtime-introspection problem — querying live WASM state during a test — is solved inside the game by [TestBridge.gd](/devlog/test-framework-four-tiers/), a 2,278-line autoload that's been working for months. The "runtime control" philosophy that makes `tomyud1` interesting is a feature I already have, in a different shape, that I don't want to compete with.
- **Cadence ownership.** `tomyud1` ships weekly. `youichi-uda` Pro ships weekly. Daily-driver tooling on someone else's release treadmill is a coupling I don't want.
- **Specific surface I need.** Tickets ops, Playwright runner orchestration, AppC sync, batch G3→G4 refactor. None of those are anywhere on the Godot-MCP landscape because they're specific to my stack. I'd be building them as a sibling server anyway.

So the architecture is: **one private server, owned by me, that wraps the existing primitives**. TestBridge keeps doing what it does. `redeploy_web.sh` keeps doing what it does. The Python migration script keeps doing what it does. The MCP server is a new agent-facing surface that calls *into* each of them with structured tool calls, replacing the bash heredocs.

The plugin half — the GDScript that lives inside Godot — is being cherry-picked from `youichi-uda`'s Pro version. The Pro Node server is paid; I'm not lifting that. But the plugin is MIT-licensed (verified before any code lands), and the patterns inside it (`property_parser.gd`, `command_router.gd`) are exactly what I need without the tax of replicating them.

## What Stage 1 actually shipped

Heavy documentation. One stub tool. Zero working logic.

This was a deliberate call. The MCP spec requires tool registration to be discoverable — clients ask the server "what tools do you have?" before invoking anything. I wanted that registration surface to exist with the real schema for `audit_g4_web_compat` (the headline tool I'm building first), but I wanted it to **honestly** decline the work for now: when an agent calls it, the response says *Stage 1 stub — implementation in Stage 2*. Better than a fake-success placeholder. The contract is real; the work is queued.

The headline document, `INTEGRATION.md`, walks through every existing primitive my agents currently shell out to and shows the data flow once it's wrapped. It's the kind of doc I wished existed for the projects I evaluated. Mine has it because I wrote it first; theirs don't because their authors shipped code first and documented later.

I'm aware this is the inverse of the usual "show me the code" advice. The justification is that the architecture is what's load-bearing here, not the implementation. Wrapping `redeploy_web.sh` in a typed tool is two days of work; deciding *whether to wrap or replace* is the decision that compounds, and it's the decision I'd get wrong without thinking it through in writing.

## What's coming

<!-- TODO when Stage 2 lands: replace this section with concrete before/after numbers from the first shipped tool. Best candidate is ticket_op since it has the highest call frequency (~30/session) and the most dramatic before/after diff. -->

Stage 2 ships the first real tools: `ticket_op` (the heredoc-killer), `redeploy` (structured version output), `testbridge_query` and `testbridge_mutate` (no more shell-quoting), and `playwright_run` (structured failures with screenshot paths). These are the highest-frequency operations in my current sessions; the migration math is straightforward.

Stage 3 starts cherry-picking the MIT plugin patterns. Stage 4 is when I start extracting generic tools — the web-export audit, the WASM-hang diagnostic — as standalone open-source releases. The audience for *Godot 4 web export with LLM-assisted dev* is growing; the audience for *G3→G4 migration* is shrinking. I want the durable contributions out in the world.

## On keeping the parent repo private (for now)

`allbyte-mcp` itself stays private through v1.0. The reasoning is partly political — `youichi-uda`'s Pro product is the closest analog, and I'd rather not look like a free competitor while my implementation is still finding its shape. Partly quality-bar — inviting community contributions before the codebase is stable means churn I can't absorb. And partly because the OSS contribution path doesn't actually require my repo to be public: PRs back to `youichi-uda`'s MIT plugin, or standalone open-source releases of generic tools extracted from this codebase, work fine either way.

Path B (open-source the whole thing) stays available. v1.0 is when I revisit.

<!-- TODO before publishing: replace this final section with measurements from the first shipped tool. Candidates:
- token-count delta per ticket update (heredoc bytes vs ticket_op bytes)
- agent-error-rate delta (regex misses on pytest stdout vs structured failures)
- session-time delta on a representative session (probably hard to measure cleanly)
Pick whichever has the cleanest before/after. The tool calls won't write themselves, but at least one of them needs to be live before this post helps anyone. -->
