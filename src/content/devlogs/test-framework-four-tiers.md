---
title: "A Four-Tier Test Framework for an AI-Built Game"
description: "How I test a Godot game built by AI agents. Four tiers — unit, integration, Playwright-over-WASM, and a full happy-path playthrough — each with a clear job, a clear runtime, and a clear trigger. Vera owns all four; the CI pyramid only earns its shape once the bottom is cheap and the top is real."
pubDate: 2026-04-14T14:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["testing", "gut", "playwright", "godot", "quality-gates", "ai-pair-programming"]
draft: true
---

Writing tests by hand has a natural ceiling. Writing tests with an AI agent that never gets bored has a very different ceiling — but only if the test framework itself is shaped so the agent can actually contribute at every level. Early on, Vera (my test lead) would write ten unit tests for a new scene and then shrug at anything bigger. The framework didn't give her anywhere to put integration or end-to-end work. So we built one.

It has four tiers now. Each has a specific job, a specific runtime budget, and a specific trigger. None of them overlap, and together they replace the one thing I care about catching: *a regression that reaches the live web build*.

## Tier 1 — Unit (GUT)

**Runtime:** ~8ms per test. **Where:** Godot GUT framework. **Scope:** pure functions, data transforms, small isolated classes.

These are the cheap ones. They don't load scenes, don't touch the filesystem, don't spin up autoloads. Vera writes most of them first, alongside the ticket's success criteria, before Nix starts the implementation. When they fail, the cause is usually a single line.

The bottom of the pyramid has to be free, or nothing above it earns its runtime.

## Tier 2 — Integration (scene-tree)

**Runtime:** ~100ms–1s per test. **Where:** GUT with scene tree. **Scope:** scene loading, autoload interactions, event bus, save/load round-trips.

These tests instantiate real scenes and drive them through the event system. They catch the bugs unit tests can't see: an autoload race, a signal wired to the wrong handler, a save schema that silently drops a field.

## Tier 3 — Playwright over WASM

**Runtime:** 1–20s per test. **Where:** Playwright driving the Godot HTML5 export in a headless browser. **Scope:** the actual web build, with the actual TestBridge injecting inputs and reading state.

This tier is the firewall between "works in the Godot editor" and "works on allbyte.studio". The web export has its own failure modes — SharedArrayBuffer headers, WASM memory limits, autoload init order under the browser's async loader — that Tier 1 and 2 can't touch. Every Tier 3 test runs the actual shipped build in the actual browser.

Port wrote the TestBridge; Vera writes the test shapes against it.

## Tier 4 — Happy-path playthrough

**Runtime:** minutes per run. **Where:** Playwright driving the web build like a player. **Scope:** *can a user actually play the game, start to finish on a defined path, without getting stuck?*

This is the newest tier and the one that changed how I think about "done." Tiers 1–3 can all pass while the game is unplayable — a menu option lands on the wrong scene, a required dialogue is skipped on some path, a boss fight softlocks if the player picks a particular loadout. The playthrough tier catches that because it literally plays the game.

It runs a scripted-but-realistic path: launch the web build, go through the intro, make the expected player choices, walk the expected route, interact with the expected NPCs, and end on a known beat. Anything that would stop a real first-time player stops the test. No assertion scripting needed — if the scene graph wedges or the input queue stalls, the test stalls.

> **This is essentially an acceptance test.** When Tier 4 passes, the milestone is releasable.

The playthrough doesn't run on every ticket. It runs on every milestone release candidate, and it's what gates a push to production.

## Why four tiers and not three

The old shape was three tiers and a lot of hope. Tier 3 tests exercised *scenes* but never a *playthrough*; the assumption was that if every scene worked in isolation, stringing them together would too. That assumption broke often enough — save state carrying wrong flags across scenes, dialogue branches that only misbehave after a specific earlier choice — that I stopped trusting a green Tier 3 run as "ship it."

Adding Tier 4 split the question into two cleaner ones:
- **Does each piece work?** — Tiers 1–3
- **Does the whole thing cohere into a game a player can finish?** — Tier 4

Both answers are binary, both are automated, neither has to compromise for the other.

## How Vera spawns workers across tiers

Every ticket has paired tests — Vera writes the test spec during Tech Review, and it's signed off before the ticket moves to Ready. During implementation, Vera can spawn multiple subagents in parallel: a GUT batch for Tier 1, an integration batch for Tier 2, a Playwright batch for Tier 3, and a playthrough regeneration batch for Tier 4 when the path through a changed scene needs updating. Tests are embarrassingly parallel; the framework is shaped to take advantage of that.

## The Dev Console view

The Tests tab in the [Dev Console](/devlog/dev-console-agent-dashboard/) shows tier status per subsystem as a tree. Each leaf is a test file, each node rolls up pass/fail counts by tier. I don't usually open this tab unless something red shows up on the Console landing — but when it does, the tree is where I go to find out which tier broke and what regressed.

---

More on how Vera's workers structure their work, how Tier 4 paths are defined, and how TestBridge lets Playwright read Godot state will land in follow-up posts.
