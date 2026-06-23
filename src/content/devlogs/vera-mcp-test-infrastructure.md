---
title: "Testing a Godot Web Game: Five Tiers and a Tool Surface"
description: "The test framework is the real leverage behind building a game with AI — not the AI. Five test tiers, from microsecond unit checks to ten-minute story-arc playthroughs, and the nine-tool MCP surface my test lead drives them through."
pubDate: 2026-06-23T18:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["testing", "mcp", "playwright", "godot", "quality-gates", "ai-pair-programming"]
draft: false
---

The thing that lets me build a game this fast with an AI isn't the AI. It's the test loop.

If an agent can make a change and get a reliable answer to "did that break anything?" in minutes, it can write code wicked fast. If it can't, you're back to one of two bad options: a human verifies every change by hand (slow), or the AI ships code nobody checked (risky). The test framework is what turns the first option into the third one — fast *and* safe. So the framework is the actual leverage, and it's worth shaping deliberately.

This is how it's shaped: five test tiers, and the tool surface my test lead — an agent named Vera — drives them through.

## Why a browser game is a good test target

The game ships as a Godot 4 web export, and that turns out to be a better automated-testing target than native Godot tests:

- **Real browser, real rendering.** WebGL shaders actually compile, the audio context actually fights the autoplay policy, input actually flows through the DOM. Native tests skip all of that and ship the bugs to real players.
- **JavaScript interop is a free test bridge.** The game publishes its state to `window.gameState` every frame and reads commands back from `window._test*` hooks. No native harness gives you that shape for nothing.
- **Screenshots don't lie.** Playwright captures the real WASM render output, pixel for pixel, so visual regressions are catchable.
- **It validates the deploy path.** A test that passes against a locally-served build is exercising the same code that ships to allbyte.studio.

All of that only compounds if the suite stays fast, organized, and writable. That's what the tier model is for.

## The five tiers

The core insight: most tests don't care *how you reached* a context — they care *what happens when you do X to it*. Treating "reach the context" as part of the test, via live gameplay setup, is expensive, duplicated everywhere, and a huge flakiness surface. Treating it as a separate, cheap concern solves nearly every scaling problem. The five tiers are ordered by exactly that — how expensive and how realistic the setup is, fastest and most isolated first.

### Tier 1 — Unit (pure GDScript)

**Runtime:** microseconds to milliseconds. **Scope:** pure class methods executed in isolation — no `SceneTree`, no autoloads, no scene. Helper math, static methods, class invariants.

These are the free ones. They run through GUT on desktop headless. In practice this tier stays small, because most interesting GDScript invariants need at least a tree — which is the next tier.

### Tier 2 — Engine-native headless (the fast inner loop)

**Runtime:** ~8–9s cold start, then nearly free per additional assertion. **Scope:** a script that drives real Godot 4 headless against the game — no browser, no WASM, no PCK rebuild. Autoload presence, DataStore parses, signal wiring, save-schema round-trips.

The win here isn't raw cold-start time (Playwright amortizes that too). The win is that editing a `.gd` file lets a Tier 2 test run *immediately* — no `redeploy_web.sh` round-trip — and you get many assertions per cold start, with no Chrome zombies and no port races. It's the tier an agent lives in while iterating.

### Tier 3 — Scene-fixture (WASM) — the default

**Runtime:** 1–3s per test. **Scope:** the actual web build running in a headless browser, with state reached one of two cheap ways:

- **Scene-based** — a tiny scene checked into `TestScenes/`, built only to exercise one subsystem. A movement room with four walls and a controller; a sprite-matrix scene that validates fifty sprites in one screenshot pass. The scene *is* the world, so it's perfectly deterministic and flat-scaling: a hundred tests in a scene pay the same setup as one.
- **Save-fixture** — a JSON save state, checked into git, injected straight into a slot. For when the subject genuinely needs real game state (a specific event condition, a real cutscene aftermath). The harness never models the save schema; the game owns it, and a regenerate script re-captures fixtures when the schema moves.

This is where 60–70% of tests should live. Most of the suite's leverage is here.

### Tier 4 — Live traversal + save/load (WASM)

**Runtime:** 15–30s per test. **Scope:** the full player-facing flow, end to end — boot, new game, walk out the door, room-to-room, a real save/load round-trip through the actual menu. These are *canaries*: maybe 5–10 across the whole suite. They're the hardest tests to keep green, by nature, so most things that feel like a Tier 4 test should really be a Tier 3 one with state set via a hook or fixture.

### Tier 5 — Playthrough + events (WASM)

**Runtime:** 2–10 minutes per section. **Scope:** playing through an actual slice of the story — advancing dialogue, walking between scenes, firing events in sequence, like a real player. Tier 4 asks "does this one traversal work?"; Tier 5 asks "does a *multi-scene story arc* cohere?" There are only a few of these, one per story section, and they run last.

> **This is the acceptance tier.** When the Tier 5 sections pass, the milestone is releasable. It's what gates a push to production.

### Picking a tier

The rule is a ladder — take the first one that works: pure method with no engine? Tier 1. Assertable against autoload/DataStore without a browser? Tier 2. Exercisable in an isolated test scene? Tier 3 (scene). Needs real game state? Tier 3 (save-fixture). Verifying one traversal or a save/load round-trip? Tier 4. Verifying a story arc plays through? Tier 5.

This replaced an older four-tier model that carried a parallel "Shape A/B/C/D" vocabulary alongside it. Collapsing both into a single tier axis killed a recurring tax — *which bucket is this?* — that the agents (and I) kept paying. One axis, five rungs, no overlap.

## The friction that surfaced at scale

The tier model is a structure. Living inside it, day after day, surfaced friction the structure didn't predict — and an AI hits that friction roughly ten times faster than a human, because it never gets bored and just produces ten times the output across every place where the framework is soft.

- **Scaffolding was repetitive.** Every new test started from a near-identical template — imports, fixture wiring, a TestBridge handle, the assertion shape for its tier. Vera would copy a similar test and edit. Sometimes the wrong tier's template. Sometimes a forgotten marker.
- **Marker audits were easy to miss.** Tests need tier markers so the runner can filter by speed. Without them, everything runs in the slow bucket; with the wrong one, a test runs in the wrong tier. Caught by hand, mostly.
- **`test_index.json` was hand-maintained.** A registry mapping test IDs to paths and tiers, edited by hand, validated by nobody.
- **Tier-aware running was a bash-flag dance.** "Run the menu subsystem's Tier 3 tests" meant remembering marker syntax, a file glob, fail-fast, last-failed, cache-disable flags — three or four invocations per regression cycle, each subtly different.
- **Parsing pytest stdout was the worst of it.** The most frequent operation is "run this, find the failure." Pytest's output is human-friendly, which means programmatically scraping `FAILED` lines and tracebacks is neither hard nor reliable — and a chatty session pushes the real failure out of the `tail` window.
- **Coverage was a manual cross-reference.** Every ticket names the test that should validate each success criterion. Nobody was checking those tests existed. Some did; some pointed at files that were never written.

None of this is unique to AI-driven testing. Any team at scale hits it. The agent just hits it sooner and harder. The fix was a tool surface that actually knows about the framework.

## Vera-MCP — the surface on top

Nine tools, scoped to the test domain, each removing a specific item from that list. They're delivered as a private MCP server the agents call instead of raw bash.

**Authoring.** `test_scaffold(ticket_id)` reads a ticket's title, description, and success criteria, runs them through a small phrase classifier to infer the right tier and shape, and returns a fully-templated test file — imports, fixture wiring, the assertion skeleton, the right markers, a stub per declared criterion. The classifier doesn't have to be smart, just consistent; it lands the right shape on the first pass about 90% of the time, and wrong picks get caught at review.

**Hygiene.** `test_marker_audit` walks the suite and reports untagged tests, double-tagged tests, mis-tiered tests (a "tier 1" that secretly loads a scene and runs 800ms), and overall tier balance. `test_index_op` does structured, schema-validated, atomic CRUD on the registry so nobody hand-edits it. `xfail_manifest` scans every test file for its test / xfail / skip counts and returns the inventory up front — it front-loads what used to be the agent's whole triage discovery phase into one call.

**Running.** `test_run_by_tier({tier, glob, failed_only})` is the canonical tier-filtered run — the bash-flag dance, gone. `pick_tests` takes the changed files plus a declared change tier and a wall-time budget and returns the ordered set of tests to run as a regression gate, dropping lower-priority ones when the budget's blown. And `playwright_run` is the one I lean on most: it wraps pytest with a JSON report and returns a structured envelope instead of stdout to scrape.

Before:

```bash
pytest WebTests/test_laria_z_church.py -v 2>&1 | tail -100
# then regex-scan for FAILED, tracebacks, screenshot paths — and hope
# the failure wasn't in the lines above the tail window
```

After:

```
playwright_run({pattern: "test_laria_z_church.py", headed: false})
```

```json
{
  "ok": false, "passed": 6, "failed": 2, "duration_s": 24.8,
  "failures": [
    {
      "test": "test_laria_z_church.py::test_priest_dialogue_advances",
      "exception": "AssertionError: expected option 'Yes', got 'Maybe'",
      "screenshot": "WebTests/_artifacts/test_priest_dialogue_advances.png",
      "traceback_excerpt": "...last 6 lines..."
    }
  ]
}
```

The agent maps over `failures[]` and acts per-failure; a re-run uses `failed_only: true`. The report is reliable where the regex never was, and every regression cycle since the switch has been smoother.

**Reporting.** `test_coverage_report` cross-references each ticket's named test against the suite and flags the gaps — criteria whose test file doesn't exist, or exists but doesn't assert what the criterion claimed. That catches the common failure mode: a ticket ships with a `testPath` that was always just a future plan. `visual_baseline` collapses the screenshot-regression workflow — capture a reference at a known-good version, then pixel-diff future runs against the committed baseline — into one call instead of a hand-rolled capture script per screen.

## Where this actually stands

All nine tools ship and are in daily use. I want to be precise about what that does and doesn't mean.

It does **not** mean I'm declaring this a proven, general-purpose product. Each tool earns its place through a parity check — it has to match its bash predecessor across a run of real sessions before the agent's instructions flip from "use bash" to "prefer the tool." That's a deliberately slow bar, because a test tool that's subtly wrong is worse than no tool.

The bet underneath all of it — that a test framework *shaped so an AI can contribute at every tier* gives back more than it costs — is one I'm still measuring, not one I've won. What I can say is that the reject-and-respawn rate on test work dropped noticeably once the framework conventions lived in the scaffold output instead of in an agent's memory, and that the structured `playwright_run` envelope alone paid for the whole effort.

Browser-tested Godot — Playwright over a real WASM build, with agent-callable orchestration around it — is a genuine gap in the ecosystem; the mature tools all stop at GUT or editor-side control. If the bet keeps holding up through more dogfooding, the project-agnostic core here is worth extracting. Until then it's specific to The Chronicles of Nesis, and the design rationale lives in the repo for anyone modeling their own.
