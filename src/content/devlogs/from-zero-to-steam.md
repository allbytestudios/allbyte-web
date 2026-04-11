---
title: "From Zero to Steam: Building Chronicles of Nesis"
description: "How a tactical RPG went from a turn queue on a blank grid to a playable demo on Steam — built solo in Godot 3.5 over four years."
pubDate: 2025-04-11
category: "narrative"
devlog: "chronicles"
tags: ["godot", "gamedev", "steam", "tactical-rpg", "indie"]
---

I've been a fan of 90s JRPGs for as long as I can remember, and I've been trying to capture the feel of them for about a decade. The problem I always had with tactical games is that they typically only focus on combat — you fight on a grid, but you never feel connected to the world or the characters outside of battle. There's no town to walk through, no NPCs to talk to, no sense of place.

I wanted to bridge that gap: the depth of tactical combat with the vast, beautiful worlds that pre-rendered graphics made possible in the 90s. The games that shaped the vision: **Final Fantasy Tactics** for combat, **Star Ocean 2** for art style, **Jade Cocoon** for world and art design, **Final Fantasy 7** for class configurability, and **Chrono Trigger** for combat transitions.

The first commit was September 30, 2021. A turn queue and a blank grid. Four years later, The Chronicles of Nesis is on Steam with a playable demo, original music, handcrafted pixel art, and a world that's still growing.

## Why Godot 3.5

I picked Godot because it was free, open source, and small enough to understand. Unity was the obvious choice at the time, but I didn't want to build on a platform where the licensing terms could change under me. (That instinct aged well.)

Godot 3.5 specifically because GDScript felt natural — Python-like syntax, no boilerplate, and the scene/node architecture clicked immediately for a tile-based game. Every scene is a reusable building block. A battle grid, a town square, a dialogue box — they're all just scenes composed of nodes.

The tradeoff: Godot 3.5's documentation was thin in places, and the community was smaller. When I hit edge cases — isometric tile math, camera clamping across scene transitions, shader quirks — I was often reading source code instead of tutorials.

## The Grid

The first vision was the grid. I took a Star Ocean 2 screenshot and laid a grid on top of it and asked: could I just lay a grid on any pre-rendered background? Possibly — certainly if the background was built with a grid in mind. The catch is the art needs to account for the fact that the grid expects the distance from camera to every grid space to be equal, and the player expects all open space to be part of the grid. If the artist keeps this in mind, then any pre-rendered scene could become a tactical battlefield whenever we want.

That was the spark. But the grid overlay raised a second question: how does battle start? I never minded random encounters, but I always loved Chrono Trigger's seamless transitions — the world shifts into combat without a loading screen or a separate battle arena. A grid that overlays the existing background lends itself naturally to that. Enemies could be visible on the map, and when combat triggers, the grid just appears on the same scene. No teleport to a separate battle screen.

I spent weeks getting Godot to transition from KinematicBody2D collision objects (the exploration mode) to Path2D-based movement on an isometric grid (the tactical mode). It was a painful rework — two completely different movement systems that needed to coexist in the same scene. But once I saw it working, the grid fading in over the pre-rendered background with enemies already in position, I felt like I had something real.

The initial prototype was top-down. Within two weeks I switched to isometric — the depth and perspective made the game feel like a real place instead of a board game. That migration (October 12, 2021: "Moving top-down tilemap to iso tilemap") broke almost everything. Unit placement, camera calculations, mouse-to-tile mapping — all of it had to be reworked for the new coordinate system.

The grid handles movement ranges in tiers. When you select a unit, the reachable tiles fan out based on action points and movement cost. Tiles have terrain types that affect traversal. The system calculates valid paths, highlights targetable cells for attacks, and manages the turn queue that determines who acts next.

Getting the grid right took most of October 2021. By the end of the month I had units moving, attacking, and dying on an isometric battlefield with basic turn-based combat. It was ugly, but it worked.

## Building Laria

I wanted to start the story in a far-off location, peaceful — the quintessential "everything's fine, then things get real" opening. Not FF7 (which I love), where things are real from minute one and then get nuts. I got a lot of inspiration from Nausicaä of the Valley of the Wind — an isolated village on the edge of something larger. Laria was born.

MainSquare was the first real scene — a town center with NPCs, a windmill, and a church visible in the background. It went through several art passes as my pixel art improved (the December 2021 commits are mostly artwork updates and perspective fixes).

The town grew organically:
- **MainSquare** — the hub, where the story starts
- **ChurchSquare** — interior scenes with lighting effects
- **Windmill** — multi-floor interior with a fire effect and a basement puzzle involving a gear mechanism
- **Waterways** — an underground network of channels, the first real dungeon content
- **Mayor's House** — story events and NPC interactions

Each area is its own Godot scene with camera limits, NPC placements, interactable objects, and event triggers. Scene transitions handle the player's position, facing direction, and any active state (like quest progress).

## Dialogue and Events

The dialogue system went through a "massive rewrite" in January 2023 — that's literally what the commit says. The original version stored dialogue in a SQLite database and parsed it with regex for branching options. It worked, but adding new conversations was painful.

I was inspired by RPG Maker's event system. It made triggering events and storing progression super simple. I took that design and wrote a rough variable command tooling — `@` for triggering special commands and `{}` for giving params. I knew I wanted events to be triggered frequently, and I wanted to invest in something that would let me create custom events on a whim.

I extended the Scene object to parse these commands, which let me control player movement, SFX, music, visibility, camera, dialogue — all from just creating strings in a database. Want an NPC to walk to a specific spot, turn to face the player, and trigger a battle? That's a sequence of `@` commands stored as text. No code changes needed for new events.

Branching dialogue uses an option schema — the player sees choices, each choice maps to a different command sequence. Conditional logic checks quest state, inventory, and party composition to determine which options are available.

## Save/Load and the Database

Game state lived in SQLite. I created a dedicated Data Access Layer (DAL) object to handle all persistence, and refactored it when I realized there are two types of state: game state (read-only data like base stats, item definitions, skill trees, dialogue) and user state (everything the player changes — equipment, quest progress, treasure collection, save data). Separating these made the codebase much cleaner. Character stats, equipment, inventory, quest progress, treasure collection status, skill trees — all of it persists through the DAL. (SQLite ended up being a huge pain when it came time to export for the web — the web export was critical for closing the feedback loop with Claude, more on both in the [web export post](/devlog/web-export-and-playwright/).)

The save system went through multiple iterations:
- December 2022: Basic save/load for position and scene
- Then equipment persistence, then skill trees, then treasure locations
- January 2025: Full game save DB rewrite to handle the growing complexity

The database approach means I can query game state from anywhere — a dialogue trigger can check if the player has a specific item, a shop can read inventory, a battle can pull character stats. It's not the most performant approach, but for a turn-based game where nothing happens in real time, it works. One thing I am glad for is the DAL layer. It created a logical separation between the persistence store and the rest of my code logic. While SQLite issues were a pain, I could just stub the DAL layer out and the rest could just work.

## Controller Support

I realized users wanted controller support. It felt counter-intuitive for a tactical game, but as soon as I bought a PC controller and started using it I was confident users were right. While I was convinced, I wasn't ready for the breadth of changes that controller support slowly revealed. It's intense — especially for a menu-heavy game.

Summer 2025 was the controller push. Adding controller support touched everything:
- Skill tree navigation (July 10)
- Combat tile selection and ability targeting (July 19)
- Shop menus (July 28)
- Title screen and difficulty settings (August 26)

The combat controller was the hardest part. Mouse-based tile selection is intuitive — you point at a tile and click. Controller-based selection needs a cursor that snaps to the grid, respects movement ranges, and handles diagonal isometric movement with a D-pad. It took about three weeks to get right.

## Demo Prep and Steam

August 2025 was bug-fix month. "Numerous bug fixes for demo prep" is the commit that marks the transition from "game I'm building" to "game other people will play." That shift changes everything — edge cases that I'd been ignoring suddenly matter. Menu states that soft-lock. Camera positions that clip. Dialogue that fires out of order.

The difficulty setting went in on August 26, the same day the main menu was finalized. The game was playable end-to-end through Laria's content, with save/load, controller support, and a title screen that didn't look like a placeholder.

Getting on Steam felt daunting. In retrospect it was easy, given the complexity of putting code onto a public repository that allows anyone to play it. But there was a lot — creating an actual LLC, filling out paperwork. If it wasn't for the saints posting the things they run into on Reddit, I'd still be messaging back and forth with Steam. I'm looking at my Google history and it's full of "I 'published' a demo, but it's not visible" and "What's the difference between a separate demo page and an integrated demo page." The game wasn't finished. It still isn't. But it was playable, and that was enough.

## What Shipped

The Steam demo includes:
- Full tactical combat on isometric grids
- Elias as the playable character with a skill tree and equipment
- Laria: MainSquare, ChurchSquare, Windmill (3 floors), Waterways (12 rooms)
- Slime enemies and a boss slime encounter
- NPC dialogue with branching options and quest progression
- Save/load system
- Original music and sound effects
- Controller support
- Difficulty settings

It's a vertical slice of what the full game will be.
