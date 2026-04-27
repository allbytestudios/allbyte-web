---
title: "Vera-MCP: When a Custom Test Framework Outgrew Its Shell Scripts"
description: "I built a four-tier test framework so AI agents could contribute at every level. Then I built an MCP server on top because the framework had complexity the shell wrappers couldn't carry. Tests, tiers, and the F1 phrase classifier that picks the right test shape from a ticket."
pubDate: 2026-04-27T20:30:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["testing", "mcp", "playwright", "godot", "quality-gates", "ai-pair-programming"]
draft: true
---

<!--
DRAFT NOTE — Vera-MCP deep-dive (post 3 of 4). Folds in the previously-drafted
test-framework-four-tiers.md content as the framework-backstory section.
Old draft can be deleted once this post is approved for promotion.
Series:
  1. Why build an MCP server? Why build three? (hub)
  2. Port-MCP — Godot / web-export
  3. (this) Vera-MCP — Test infrastructure
  4. Arc-MCP — Orchestration
-->

Writing tests by hand has a natural ceiling. Writing tests with an AI agent that never gets bored has a very different ceiling — but only if the test framework itself is shaped so the agent can actually contribute at every level. Early on, Vera (my test lead) would write ten unit tests for a new scene and then shrug at anything bigger. The framework didn't give her anywhere to put integration or end-to-end work. So we built one.

It has four tiers now. Each has a specific job, a specific runtime budget, and a specific trigger. None of them overlap, and together they replace the one thing I care about catching: *a regression that reaches the live web build*.

This post is the third in a [four-part series on MCP](/devlog/why-build-mcp-and-why-three/). The first framed when MCP earns its complexity and why I split one server into three. This one covers the test-infrastructure server — Vera-MCP — and the framework story that led to it.

## The four tiers

The shape that worked, after several iterations:

### Tier 1 — Unit (GUT)

**Runtime:** ~8ms per test. **Where:** Godot GUT framework. **Scope:** pure functions, data transforms, small isolated classes.

These are the cheap ones. They don't load scenes, don't touch the filesystem, don't spin up autoloads. Vera writes most of them first, alongside the ticket's success criteria, before Nix starts the implementation. When they fail, the cause is usually a single line.

The bottom of the pyramid has to be free, or nothing above it earns its runtime.

### Tier 2 — Integration (scene-tree)

**Runtime:** ~100ms–1s per test. **Where:** GUT with scene tree. **Scope:** scene loading, autoload interactions, event bus, save/load round-trips.

These tests instantiate real scenes and drive them through the event system. They catch the bugs unit tests can't see: an autoload race, a signal wired to the wrong handler, a save schema that silently drops a field.

### Tier 3 — Playwright over WASM

**Runtime:** 1–20s per test. **Where:** Playwright driving the Godot HTML5 export in a headless browser. **Scope:** the actual web build, with the actual TestBridge injecting inputs and reading state.

This tier is the firewall between "works in the Godot editor" and "works on allbyte.studio". The web export has its own failure modes — SharedArrayBuffer headers, WASM memory limits, autoload init order under the browser's async loader — that Tier 1 and 2 can't touch. Every Tier 3 test runs the actual shipped build in the actual browser.

Port wrote the TestBridge; Vera writes the test shapes against it.

### Tier 4 — Happy-path playthrough

**Runtime:** minutes per run. **Where:** Playwright driving the web build like a player. **Scope:** *can a user actually play the game, start to finish on a defined path, without getting stuck?*

This is the newest tier and the one that changed how I think about "done." Tiers 1–3 can all pass while the game is unplayable — a menu option lands on the wrong scene, a required dialogue is skipped on some path, a boss fight softlocks if the player picks a particular loadout. The playthrough tier catches that because it literally plays the game.

It runs a scripted-but-realistic path: launch the web build, go through the intro, make the expected player choices, walk the expected route, interact with the expected NPCs, and end on a known beat. Anything that would stop a real first-time player stops the test. No assertion scripting needed — if the scene graph wedges or the input queue stalls, the test stalls.

> **This is essentially an acceptance test.** When Tier 4 passes, the milestone is releasable.

The playthrough doesn't run on every ticket. It runs on every milestone release candidate, and it's what gates a push to production.

### Why four and not three

The old shape was three tiers and a lot of hope. Tier 3 tests exercised *scenes* but never a *playthrough*; the assumption was that if every scene worked in isolation, stringing them together would too. That assumption broke often enough — save state carrying wrong flags across scenes, dialogue branches that only misbehave after a specific earlier choice — that I stopped trusting a green Tier 3 run as "ship it."

Adding Tier 4 split the question into two cleaner ones:
- **Does each piece work?** — Tiers 1–3
- **Does the whole thing cohere into a game a player can finish?** — Tier 4

Both answers are binary, both are automated, neither has to compromise for the other.

## The pain that surfaced at scale

The framework above is a structure. Living inside it, day after day, surfaced friction the structure didn't predict.

**Test scaffolding was repetitive.** Every new test started from a near-identical template: imports, fixture setup, a TestBridge handle, the assertion shape that matched the tier. Vera would copy a similar test, rename, edit. Sometimes she'd copy the wrong tier's template. Sometimes she'd forget the marker. The framework rewarded uniformity but didn't enforce it; the agent had to remember.

**Marker audit was easy to miss.** Tier 1 and Tier 2 tests need pytest markers (`@pytest.mark.tier1`, `@pytest.mark.tier2`) so the runner can filter by speed. Without markers, the runner runs everything; with the wrong markers, tests run in the wrong tier. Vera caught most marker mistakes by hand. Sometimes she didn't.

**`test_index.json` was hand-maintained.** A separate registry mapping test IDs to file paths, tiers, and runner-tier hints. The dashboard reads it; the runner consumes it. Every new test required an `test_index.json` update, written by hand, validated by no one.

**Tier-aware running was a dance of bash flags.** "Run Tier 1 tests for the menu subsystem" meant `pytest -m tier1 WebTests/test_menu*.py`. The flags worked but they're memory tax — Vera had to remember the marker syntax, the file glob, the `-x` for fail-fast, the `--lf` for last-failed, the `-p no:cacheprovider` to avoid stale cache. Every regression cycle was three or four bash invocations with subtly different flag sets.

**Pytest stdout parsing was the bash-ratio winner.** Vera's most-frequent operation was "run this test, find the failure." Pytest's terminal output is human-friendly. Programmatically grepping for `FAILED` lines, extracting tracebacks, mapping screenshot paths back to test IDs — none of that is hard, none of it is reliable. Every chatty test session pushed the actual failure marker out of the `tail -50` window.

**Coverage was a manual cross-reference.** Each ticket had a `successCriteria.testPath` field naming the test that should validate that criterion. No one was checking that the named tests existed. Some did. Some didn't. Some pointed at files that hadn't been written yet. The list of unmet criteria was Vera's mental model, not a queryable artifact.

These pains aren't unique to AI-driven testing. Any team writing tests at scale hits them. AI agents just hit them ten times faster, because the agent doesn't get fatigued and bored — it just produces ten times as much output for ten times as many places where the framework's softness matters.

The right shape was a tool surface that knew about the framework. So I built one.

## Vera-MCP — the surface that emerged

Six tools, scoped to the test-infrastructure domain. Each one removes a specific pain from the list above.

### `test_scaffold` — generate the right shape from a ticket

Most tests live in one of four shapes. Shape A is a pure unit test — no scene tree, no fixtures beyond a couple of constructors. Shape B is an integration test that loads a save fixture into a specific scene and asserts post-load state. Shape C is a live-traversal test that drives the game through a sequence of inputs and reads state at checkpoints. Shape D is the playthrough scaffold for Tier 4.

Picking the wrong shape is the most common test-writing mistake. So `test_scaffold` infers the shape from the ticket: it reads the ticket's title, description, success criteria, and runs them through an F1 phrase classifier — a small set of keyword-and-phrase rules that map ticket language onto shape selection. "Verify save survives reload" → Shape B. "Player walks from X to Y and dialogue Z fires" → Shape C. "Compute X correctly given Y" → Shape A. The classifier doesn't have to be smart; it has to be consistent. Wrong-shape selections are caught at code review, but the right one shows up about 90% of the time on the first pass.

The agent calls `test_scaffold(ticket_id)` and gets back a fully-templated test file with imports, fixture wiring, the assertion skeleton matching the shape, the right markers, and a stub for each success criterion the ticket declared. Vera fills in the assertions; the boilerplate is gone.

### `test_marker_audit` — enforce tier balance and prevent overlap

The audit walks the test directory and reports:
- Tests with no tier marker (silently running in the slow-default bucket).
- Tests with multiple tier markers (ambiguous; runner picks one nondeterministically).
- Tests whose marker doesn't match their actual runtime profile (a "tier1" test that loads a scene tree and runs for 800ms is mis-tiered).
- Tier balance — how many tests are in each tier, whether any subsystem is missing tier-2 coverage, whether the pyramid shape is being maintained.

This used to be Vera's mental load. Now it's a periodic audit she can run at end-of-session, and a CI gate that flags drift before it accumulates.

### `test_index_op` — structured CRUD on the registry

The agents stop hand-editing `test_index.json`. `test_index_op({action: "add", id, path, tier, ...})` validates the entry against a schema, deduplicates against existing entries, writes atomically. The dashboard reads the same file and gets a cleaner, never-corrupt view.

### `test_run_by_tier` — the bash-flag-dance, gone

`test_run_by_tier({tier: 2, glob: "menu*", failed_only: false})` becomes the canonical way to run a tier-filtered subset. It wraps `playwright_run` (below) with the right marker and file-glob arguments. No more remembering `-m tier2` vs `--marker tier2` (different across pytest versions). No more `-p no:cacheprovider`. No more `tail -50`-truncated output.

### `playwright_run` — structured failures, no regex

The pytest invocation pattern that ate the most time. Pre-MCP:

```bash
cd ChroniclesOfNesis && pytest WebTests/test_laria_z_church.py -v 2>&1 | tail -100
```

Then the agent regex-scans for `FAILED`, traces, screenshot paths. Sometimes it works. Sometimes the failure is in the lines before `tail -100`. Sometimes a test's traceback contains another test's name and the regex matches the wrong one.

Post-MCP:

```
playwright_run({pattern: "test_laria_z_church.py", headed: false})
```

Returns:

```json
{
  "ok": false,
  "passed": 6,
  "failed": 2,
  "errors": 0,
  "skipped": 0,
  "duration_s": 24.8,
  "failures": [
    {
      "test": "test_laria_z_church.py::test_priest_dialogue_advances",
      "phase": "call",
      "exception": "AssertionError: expected dialogue option 'Yes', got 'Maybe'",
      "screenshot": "WebTests/_artifacts/test_priest_dialogue_advances.png",
      "traceback_excerpt": "...last 6 lines..."
    },
    ...
  ]
}
```

Underneath, `playwright_run` invokes pytest with `--json-report`. The report is reliable; the regex was not. The agent maps over `failures[]` and acts per-failure. Re-runs use `failed_only: true`, which is `pytest --lf` with the state managed by the wrapper.

This is the single tool I'm most confident about. Every regression cycle since switching has been smoother.

### `test_coverage_report` — close the success-criteria loop

Every ticket's `successCriteria` has a `testPath` — the test that's supposed to validate that criterion. The coverage report cross-references the tickets file against `WebTests/`. For every ticket:
- Which criteria have a test file that exists?
- Which criteria point at a file that doesn't exist?
- Which criteria have a test file that exists but doesn't actually contain the assertions the criterion claimed?

The third one requires shape-matching the test against the ticket's language; it's heuristic, not exhaustive. But the first two are mechanical and they catch the common failure mode: agent moves a ticket to "ready" with a `testPath` that's a future plan, no one writes the test, the ticket ships, the criterion is unverified.

The report is machine-readable and feeds into the [Dev Console's tests tab](/devlog/dev-console-agent-dashboard/) so the gap is visible at-a-glance.

## Why Vera-MCP is a public-OSS candidate

The Godot ecosystem has two well-served test paths and one underserved one.

The two well-served:
- Pure GDScript unit tests via [GUT](https://github.com/bitwes/Gut) — mature, battle-tested.
- Editor-side runtime control via several MCP servers — `tomyud1/godot-mcp`, `youichi-uda/godot-mcp-pro`, others.

The underserved:
- **Headless web-export tests, run in a real browser, with structured agent-callable orchestration.** Playwright + Godot HTML5 + WASM is a niche but increasingly important slice (browser-based games, web demos for indie titles, AI-pair-programming workflows that need a deployable output). I can't find an existing tool that ties test scaffolding, tier-aware running, and coverage analysis into one MCP surface for this stack.

Vera-MCP is opinionated about the framework — it bakes in the four-tier model, the Shape A/B/C/D taxonomy, the marker conventions. That's a legitimate reason to keep it focused rather than trying to be a general-purpose Godot test MCP. But the core ideas — structured `playwright_run` envelope, marker-balance audit, ticket-criterion coverage report — generalize to any stack that wraps Playwright over a non-trivial runtime.

Publishing posture: this one ships open-source when the parity framework clears the bar (every tool needs N consecutive parity-matched runs against its bash equivalent before the CLAUDE.md instruction flips). Probably 4–6 weeks of dogfooding from now. Until then, the architecture and the design rationale are in `allbyte-mcp/docs/VERA_MCP.md` for anyone who wants to model their own.

## How Vera spawns workers across tiers, post-MCP

Every ticket has paired tests — Vera writes the test spec during Tech Review, and it's signed off before the ticket moves to Ready. During implementation, Vera can spawn multiple subagents in parallel: a GUT batch for Tier 1, an integration batch for Tier 2, a Playwright batch for Tier 3, a playthrough regeneration batch for Tier 4 when the path through a changed scene needs updating.

Pre-MCP, each of those batches required Vera to brief the worker on framework conventions: which shape, which markers, which assertion style. The worker then guessed, sometimes wrongly, and the worker review caught it.

Post-MCP, the worker calls `test_scaffold(ticket_id)` and the framework conventions are in the resulting file. Vera reviews assertion correctness, not framework conformance. The reject-and-respawn rate dropped notably — not measured rigorously, but enough to feel.

## Status, and what comes next

Vera-MCP is mid-build. As of this writing:

- ✅ `test_scaffold` shipped — F1 classifier passing on a reference ticket set.
- ✅ `test_marker_audit` shipped.
- ✅ `playwright_run` shipped — the most-used tool of the six.
- 🚧 `test_index_op` in flight.
- 🚧 `test_run_by_tier` in flight (depends on `playwright_run`).
- 🚧 `test_coverage_report` in flight.

Each tool ships with parity coverage against its bash predecessor — N consecutive matched runs before its CLAUDE.md instruction flips from "use bash" to "prefer MCP." The [parity framework post in this series](/devlog/why-build-mcp-and-why-three/) covers the cutover protocol; the per-tool ledger is in `allbyte-mcp/docs/PARITY_LEDGER.md`.

The hub post for this series covers the why-three. The [Port-MCP deep-dive](#) covers the Godot side. The [Arc-MCP deep-dive](#) covers the orchestration side, including the OTel-reality investigation that's the most surprising thing I learned in this whole arc. None of the three would have been worth doing without the others; together they're starting to feel like the right shape.
