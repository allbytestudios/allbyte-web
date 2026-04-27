---
title: "When to Build an MCP Server, and Why I Built Three"
description: "MCP isn't a wrapper around your bash scripts. It's a contract that solves problems memories, skills, and CLAUDE.md files can't. Here's when it earns its complexity, and why my one private server became three."
pubDate: 2026-04-27T20:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["mcp", "agents", "architecture", "tooling", "process"]
draft: true
---

<!--
DRAFT NOTE — hub post for a 4-part series. Status: draft until at least one
deep-dive ships with a working tool to point at. Series structure:
  1. (this) Why build an MCP server? Why build three?
  2. Port-MCP — Godot / web-export deep dive
  3. Vera-MCP — Test infrastructure deep dive
  4. Arc-MCP — Orchestration / lifecycle / OTel-reality deep dive
-->

I had a sequence of small pains that built up over months. My agents were constructing 25-line bash heredocs to update one ticket field, regex-parsing pytest output to find which test failed, shell-quoting JSON literals to push values through `live_mutate.sh`, and grepping `redeploy_web.sh` stdout for the deployed version string. None of it was hard. All of it was wrong-shape.

The right shape was [Model Context Protocol](https://modelcontextprotocol.io). I built it. Then I split it into three.

This post is the hub for a four-part series: why MCP is a different category of thing than CLAUDE.md memories and skill files, when it earns the overhead of being one, and why I ended up running three of them in a monorepo instead of the one I started with. Each of the three servers gets its own deep-dive post; this one frames the why.

## What MCP actually is

A small JSON-RPC dialect for letting an LLM call typed tools. Each tool has an input schema, a structured response envelope, and a clean error path. The model queries the server's tool list at runtime, picks one, invokes it with validated input, gets validated output. Transport is usually stdio (subprocess) or SSE (server-sent events). Anthropic's Claude Code, the Claude API, and several non-Anthropic clients are all MCP-aware.

That's the whole thing. It's not a framework. It's not a runtime. It's a contract.

## What MCP isn't, and why that matters

There are four other ways to extend an LLM's capabilities. They're all different tools.

**CLAUDE.md files** are *prompts* — instructions the model loads at session start that shape how it interprets requests. They tell the agent *what* and *why*, but every actual operation still has to be translated into a tool call (Bash, Edit, Read) at execution time. CLAUDE.md is great for "here's the architecture, here's the conventions, here's where to look first." It's not great for "every time you do X, do it this exact way" — because the agent's translation step is where the variability creeps in.

**Memories** are *durable facts* — things the agent should remember across sessions. "User prefers terse responses." "Database migration prefers integration tests over mocks." Memory tells the agent things that would be tedious to re-discover. It does nothing at execution time except show up in context.

**Skills (slash commands)** are *bundled prompts plus tool-policy hints*. A skill like `/security-review` says "load this rubric, run these checks, follow this report format." Closer to MCP than memories, but still prompt-shaped — the skill instructs the agent on how to compose existing tools. It doesn't add new ones.

**Tool definitions in the prompt** (the API approach) inject typed tools per request. Functionally similar to MCP at the model layer, but they live in the application's prompt rather than in a discoverable server. Every consumer that wants the tool reimplements it.

**MCP** is none of these. It's a runtime endpoint. The agent doesn't compose anything; it invokes. The contract — name, input shape, output shape, error shape — is enforced by the server, not by the agent's interpretation of a prompt. The same server is reachable from any MCP-aware client, including non-Anthropic ones.

The distinction matters because the failure modes are different. CLAUDE.md drift looks like "the agent did the right thing, mostly, but with subtle variations across runs." MCP drift looks like "the tool call failed loudly with a schema validation error." For some operations — anything that touches shared state, anything where correctness compounds — loud failure is what you want.

## What MCP buys you, concretely

**A deterministic envelope.** The agent gets `{ ok, version, duration_ms, index_pck_bytes, ... }` from a `redeploy` tool, not 60 lines of bash stdout that may or may not contain the version string in the spot the regex expects. No parse fragility, no chatty-export-pushed-the-version-line-out-of-the-tail-50 anxiety.

**Tool-list discovery.** The agent learns the surface at runtime. Add a new tool, restart the server, the agent's next session knows about it. CLAUDE.md updates require regenerating prompts and re-onboarding.

**Atomicity, when you write the server right.** The bash heredoc pattern for editing `tickets.json` looks like `flock /path python3 << PYEOF ... PYEOF`. The flock is correct, but every site that does the heredoc is reimplementing the locking convention. A `ticket_op` MCP tool centralizes that — one lock manager, one schema validator, one place to fix when the schema evolves. Two months later, every agent that has ever called `ticket_op` is using the current lock contract. Bash heredocs in old session transcripts are not.

**Cross-LLM portability.** This isn't immediately load-bearing for me, but it's structural. An MCP server I write today is reachable from any MCP-aware client tomorrow. The contract isn't tied to a vendor's prompt format.

**Schema-validated input.** Garbage in fails at the boundary, with a schema error pointing at the exact field. This sounds boring until you've spent twenty minutes diagnosing why a typo in a heredoc silently wrote `phase: "tessting"` to one of your tickets and propagated through three downstream agents.

## When MCP is worth building

These are the heuristics I ended up using:

1. **You call the operation at least 10 times per session.** Lower than that and the heredoc tax doesn't cross the threshold.
2. **Output parsing has a known failure mode.** Regex on stdout is the canonical signal.
3. **The operation has correctness invariants that span sites.** Locking, schema validation, write-ordering — anything where every caller has to remember to do the same thing the same way.
4. **More than one agent needs the operation.** The cost of building MCP is amortized across consumers. With one consumer the heredoc is sometimes fine.
5. **The operation will be called from a vendor you haven't picked yet.** Every MCP-aware client gets it for free.

These are the heuristics for *not* building MCP:

1. **It's a one-shot script.** A migration that runs three times total isn't worth the wrapper.
2. **The agent's existing tools compose well.** If `Read` + `Edit` + `Bash` already do the job cleanly, MCP adds ceremony without value.
3. **Your "MCP version" is just `child_process.execFile` of an existing bash command with no semantic enrichment.** Sometimes that's still worth it for the typed envelope. Often it's not.
4. **The operation is fast-evolving.** MCP tools become contracts. Contracts are expensive to break. If you're three weeks into figuring out what the operation should do, keep it as a script.

The rule of thumb that emerged: **MCP wins when the cost of getting the operation slightly wrong is high, and when more than one agent has to call it.**

## Why three servers, not one

I started with one server, `allbyte-mcp`, fifteen tools. The fifteen tools fell into three groups, but I didn't see that until I'd built about ten of them.

The three groups:

**Godot and web-export tooling.** Auditing `.gd` files for WASM-hostile patterns. Migrating G3 scenes to G4 syntax. Deploying the web export. Live-mutating game state via TestBridge. Querying the running game's state without writing a Python test. These tools touch source files, run external scripts, talk to a running WASM build. They're broadly applicable to any Godot 4 web-export project — public-OSS candidates.

**Test infrastructure.** Scaffolding new test files from templates. Auditing test markers for tier balance. Maintaining `test_index.json`. Running tests filtered by tier or marker. Mapping ticket success-criteria to actual test files for coverage analysis. These tools live next to the test suite, read tickets read-only, write test files. Also broadly applicable — Godot + Playwright test infrastructure is a documented gap.

**Orchestration.** Reading and writing `tickets.json`. Maintaining `agent_activity.json`. Clustering pending tickets into optimal dispatch bundles. These tools are *deeply* tied to my agent topology. They write the state that my orchestrator consumes. Not generic. Not OSS material.

Three groups that look obvious in retrospect. But sharing one server meant they shared a release posture, a public-vs-private boundary, a test suite, a documentation set. The Godot tools are things I'd happily ship to anyone running Godot 4 web exports; the orchestration tools are things tied to a multi-agent setup I'm not yet ready to expose. Mixing them in one server forced a single answer to "is this open?" when the right answer is per-server.

The split followed the agent topology I already had. Each lead agent — Port (web export), Vera (test infrastructure), Arc (orchestration) — already owns a CLAUDE.md hierarchy and a domain. Their MCP surface should follow. **Three servers, one per lead.** Plus a `shared` package for the locking primitive, schema validators, envelope types — anything cross-cutting.

The surfaces:

| Server | Tools | OSS posture |
|---|---|---|
| **Port-MCP** | `audit_g4_web_compat`, `batch_g3_to_g4`, `redeploy`, `live_mutate`, `testbridge_query` | Public-OSS candidate when scope-defer reverses |
| **Vera-MCP** | `test_scaffold`, `test_marker_audit`, `test_index_op`, `test_run_by_tier`, `playwright_run`, `test_coverage_report` | Public-OSS candidate |
| **Arc-MCP** | `ticket_op`, `agent_activity_op`, `backlog_cluster` | Private indefinitely |

One monorepo, npm workspaces, three servers + shared. Each package can be published independently to npm if and when it ships open-source. Cross-package refactors don't need cross-repo PRs. The shared lock manager, schema validators, and envelope types stay co-located.

## Single-writer model

The split surfaced something I hadn't articulated in the single-server design: there's exactly one writer for each shared piece of filesystem state.

Arc-MCP owns the writes to `tickets.json` and `agent_activity.json`. Port-MCP and Vera-MCP read those files freely — `test_coverage_report` cross-references tickets, `test_scaffold` reads ticket context — but they don't mutate them. There's no cross-server RPC. All servers see consistent state because the state has one writer per file.

This isn't novel; it's just the obvious thing once the boundaries are domain-aligned. But it's load-bearing — it eliminated a class of "what if Vera's running while Arc is writing?" questions that would have needed a shared lock-arbitration story across three servers. The story is: there isn't one. The shared package has the lock primitive; each writer uses it; readers don't compete.

## What's coming in the deep-dives

Each of the three servers got long enough that it deserves its own post. Headlines:

**Port-MCP — Godot / web-export.** The original survey-and-build story expands here: eight upstream Godot MCPs evaluated, none adopted, MIT plugin half cherry-picked from `youichi-uda/godot-mcp-pro`. The 16 web-compatibility audit rules. The `live_mutate` runtime path that lets agents tune visuals without restarting the game. Why this is the most likely public-OSS contribution.

**Vera-MCP — Test infrastructure.** The Shape-A/B/C/D test taxonomy and the F1 phrase classifier that picks a shape from a ticket description. The marker-audit tool that prevents tier-imbalance regressions. The coverage-report mapping from `successCriteria.testPath` to actual test files. Why Godot + Playwright together is an ecosystem gap nobody's filled.

**Arc-MCP — Orchestration.** This one got dark. The `agent_activity_op` lifecycle problem (entries linger forever without explicit move semantics; we're at 102 KB and counting). The OTel-reality investigation: I dumped every attribute Claude Code emits across a 10-span trace and found no per-subagent attribution — Anthropic ships WHO and HOW LONG, not WHAT or WHY. The layered model that resulted: Arc-driven lifecycle as the source of truth, worker self-reporting for richer state, sweep-stale as the backstop using Anthropic's `session.id` for liveness. The upstream feature request to Anthropic to add `claude_code.subagent_type` as a span attribute.

Plus a sidebar in one of them for the **parity framework** — the bash-to-MCP cutover protocol that requires N consecutive parity-matched runs across at least two scenarios per tool before flipping the default. Bash heredocs aren't deprecated by fiat; each MCP tool clears the bar with documented evidence.

---

**Posting cadence:** I'll publish each deep-dive as the corresponding tool ships its first end-to-end use. The architecture is in place; the implementation is mid-flight. I'd rather post in arrears with measured before/afters than pre-announce.

Until then, this hub frames the why. The three posts that follow will frame the what.
