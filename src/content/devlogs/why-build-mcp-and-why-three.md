---
title: "When to Build an MCP Server (and the One I Built That Died)"
description: "MCP isn't a wrapper around your bash scripts — it's a contract for the operations where getting it slightly wrong is expensive. Here's when it earns that overhead, and the speculative orchestration layer I built that sat cold for two months as proof of when it doesn't."
pubDate: 2026-06-23T17:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["mcp", "agents", "architecture", "tooling", "process"]
draft: true
---

I had a sequence of small pains that built up over months. My agents were constructing 25-line bash heredocs to update one ticket field, regex-parsing pytest output to find which test failed, shell-quoting JSON literals to push values through a mutation script, and grepping deploy stdout for the version string. None of it was hard. All of it was wrong-shape.

The right shape was [Model Context Protocol](https://modelcontextprotocol.io). I built it. Then I split it into four servers, one per agent domain.

Two months later, half of what I built is dead. Not lightly used — *dead*, state files cold for six to eight weeks. This post is the rule I extracted from building too much of it: when an MCP server is worth the overhead, how I tell, and the server that proves the negative case by sitting unused.

## What MCP actually is

A small JSON-RPC dialect for letting an LLM call typed tools. Each tool has an input schema, a structured response envelope, and a clean error path. The model queries the server's tool list at runtime, picks one, invokes it with validated input, gets validated output. Transport is usually stdio (subprocess) or SSE. Anthropic's Claude Code, the Claude API, and several non-Anthropic clients are all MCP-aware.

That's the whole thing. It's not a framework. It's not a runtime. It's a contract.

## What MCP isn't, and why that matters

There are other ways to extend an LLM, and they're all different tools:

- **CLAUDE.md files** are *prompts* — instructions loaded at session start that shape how the model interprets requests. They say *what* and *why*, but every operation still gets translated into a tool call (Bash, Edit, Read) at execution time, and that translation step is where variability creeps in.
- **Memories** are *durable facts* — "the owner prefers terse responses," "this migration prefers integration tests over mocks." They do nothing at execution time except show up in context.
- **Skills (slash commands)** are *bundled prompts plus tool-policy hints* — "load this rubric, run these checks, format the report this way." They instruct the agent on how to compose existing tools; they don't add new ones.

MCP is none of these. It's a runtime endpoint. The agent doesn't compose anything; it invokes. The contract — name, input shape, output shape, error shape — is enforced by the server, not by the agent's interpretation of a prompt.

The distinction matters because the failure modes differ. CLAUDE.md drift looks like "the agent did the right thing, mostly, but with subtle variations across runs." MCP drift looks like "the tool call failed loudly with a schema validation error." For anything that touches shared state, or where correctness compounds, loud failure is what you want.

## What MCP buys you, concretely

**A deterministic envelope.** The agent gets `{ ok, version, duration_ms, index_pck_bytes, ... }` from a `redeploy` tool, not 60 lines of stdout that may or may not contain the version string where the regex expects it.

**Schema-validated input.** Garbage fails at the boundary, with an error pointing at the exact field. This sounds boring until you've spent twenty minutes diagnosing why a typo silently wrote `phase: "tessting"` to a ticket and propagated through three downstream agents.

**Atomicity, when you write the server right.** Every bash site that edits a shared JSON file reimplements the `flock` convention. One MCP tool centralizes it — one lock manager, one schema validator, one place to fix when the schema evolves.

**Cross-LLM portability.** Not immediately load-bearing for me, but structural: a server I write today is reachable from any MCP-aware client tomorrow, without being tied to a vendor's prompt format.

## When MCP is worth building

The heuristics I landed on, *for* building:

1. **You call the operation 10+ times per session.** Below that, the heredoc tax doesn't cross the threshold.
2. **Output parsing has a known failure mode.** Regex on stdout is the canonical signal.
3. **The operation has correctness invariants that span call sites.** Locking, schema validation, write-ordering — anywhere every caller has to remember to do the same thing the same way.
4. **More than one agent needs it.** The build cost amortizes across consumers.

And the heuristics *against*:

1. **It's a one-shot script.** A migration that runs three times total isn't worth the wrapper.
2. **The agent's existing tools compose well.** If `Read` + `Edit` + `Bash` already do the job cleanly, MCP adds ceremony without value.
3. **Your "MCP version" is just `execFile` of an existing bash command with no semantic enrichment.** Sometimes the typed envelope is still worth it. Often it isn't.
4. **The operation is fast-evolving.** MCP tools become contracts, and contracts are expensive to break. If you're three weeks into figuring out what the operation should even do, keep it a script.

If I compress all of that into one sentence, it's this: **a wrapper that merely saves typing dies; a tool that removes real recurring pain or enforces a real invariant lives.** I know that's the rule because I built a whole suite and then watched which half survived contact with daily use.

## The autopsy

I split the suite into four servers along my agent topology — one per domain:

- **port-mcp** — web export, runtime inspection, scene loading, live property mutation, Godot 3→4 migration.
- **vera-mcp** — test scaffolding, tiered runs, coverage, marker audits, [visual baselines](/devlog/vera-mcp-test-infrastructure/).
- **roan-mcp** — a mechanically restricted play-mode surface for an agent that plays the game like a real user.
- **arc-mcp** — the orchestration layer: ticket phase moves, an agent-activity log, dashboard rollups, efficiency metrics, pre-dispatch context bundles, backlog clustering.

That last one was the ambition: a self-driving ticket lifecycle, agents reporting status into a JSON substrate, a dashboard reading it, efficiency tracked per cycle. Here's what I actually use, measured by when those files were last written:

| State file | Last written | Age |
|---|---|---|
| `dashboard.json` | late April | ~8 weeks |
| `efficiency_metrics.ndjson` | early May | ~7 weeks |
| `tickets.json` | early May | ~6 weeks |
| `agent_activity.json` | early June | ~2.5 weeks |

And the tell that matters most: a recent multi-hour session of real work — a new shader, directional combat VFX, a live-tuning bench, a HUD-gating fix — made **zero** MCP calls. Every redeploy was `bash`. Every test was hand-written `pytest`. Live tuning went through the raw window hook, not the `live_mutate` tool built for exactly that. The "always prefer the MCP tool" line in my CLAUDE.md was pure aspiration.

The orchestration layer didn't get *less* used. It died. Four reasons, in order of force:

1. **Token efficiency ate the ceremony.** My first rule is "reduce token usage." Ticket cuts, phase moves, activity writes, efficiency logging — all overhead with no payoff in a single-owner workflow. The rule and the ceremony were in direct conflict, and the rule won every time.
2. **The workflow collapsed to one human and one agent.** The ticket system assumes a board, a backlog, parallel leads being scheduled, a dashboard someone watches. The reality is: I talk to my orchestrator, it does the work or dispatches one lead, then commit and push. A single ~500-token hand-maintained file replaced the entire ticket database. A text file beat a schema.
3. **The consumer faded.** The orchestration server existed to feed a dashboard. When the dashboard stopped being the thing I watched, the producer had no reason to run. Infrastructure with no consumer is just maintenance cost.
4. **The bash equivalents were already good.** `redeploy` works. `pytest` works. An MCP wrapper has to be *strictly better* to displace a working habit, and for most operations it was merely *equivalent* — so the habit won.

None of this was dumb to *try*. It was dumb to keep *documenting it as mandatory* long after it stopped happening, because the docs then lied about how I actually work, and every fresh agent context paid to read the lie.

## What survived, and why

The tools that map to a real, recurring, painful manual task:

- **port-mcp's `testbridge_query` / `navigate_to_scene` / `live_mutate`** — jumping to a specific zone-pack scene and reading the console trail, or pushing a mutation into the *running* browser build, is genuinely annoying by hand. These remove pain that recurs daily.
- **vera-mcp's `visual_baseline`** — screenshot-diff scaffolding nobody wants to re-roll per screen.
- **roan-mcp** — survives for a different reason than all the others. It isn't a convenience wrapper; it's a *constraint*. Roan's "plays like a user, cannot cheat" guarantee is enforced by the tool surface itself — no `Bash`, no teleport, no flag-flip. The restriction is the product. That's load-bearing in a way a redeploy wrapper never is.

So the surviving set splits cleanly: tools that **remove pain that recurs**, and one tool that **enforces an invariant I couldn't trust an agent to honor on its own.** Everything that merely saved keystrokes is gone.

## The lesson

> Build the generic tool *after* the manual version has hurt you about three times, not before. Speculative infrastructure for an imagined workflow is the most expensive code you can write — you pay to build it, and then you pay to carry it in every doc until someone notices it's dead.

I still believe in the parity discipline I set up around the survivors: a bash-to-MCP cutover only happens after a tool matches its script across several real runs, so nothing gets deprecated by fiat. But the discipline only matters for the tools worth keeping, and most of mine weren't.

The honest summary of this whole arc: I built a four-server suite with a full orchestration substrate, and the single most useful thing I shipped from any of it was a one-line flag gate that hid a debug HUD. That should tell me — and anyone tempted to build the cathedral first — where the leverage actually is.
