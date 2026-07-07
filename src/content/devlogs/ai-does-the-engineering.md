---
title: "AI Does My Engineering. My Hands Do the Art."
description: "I'm a solo dev building a tactical RPG in Godot, and I lean on AI hard — for code, tests, infrastructure, even marketing. But there's a hard line it never crosses: the art, the music, the type. Here's where I let AI in, where I don't, and why the line is the whole point."
pubDate: 2026-07-07T12:00:00Z
category: "strategy"
devlog: "godot-and-claude"
tags: ["ai", "godot", "gamedev", "solo-dev", "craft"]
heroImage: "/og-image.jpg"
draft: false
---

I'm one person building a tactical RPG in Godot. I use AI about as aggressively as anyone — and I will not let it near the art. Those two facts aren't in tension. They're the whole strategy.

The pitch for *The Chronicles of Nesis* is 1990s-RPG craft, executed by hand, by one person. AI is what makes "by one person" survivable. The line between what it does and what it doesn't is what keeps "by hand" true.

## What AI does

Basically all the engineering:

- **GDScript and game systems** — pair-programmed. Combat, scenes, autoloads, the pack pipeline.
- **A whole engineering team, not one assistant** — I run multiple coordinated agents: an orchestrator and specialized leads for game systems, tests, and the web export. ([From 2 Claudes to 5](/devlog/two-claudes-to-five/).)
- **Tests and tooling** — a real test framework, custom MCP servers, live-reload while I play.
- **Infrastructure** — the site, the backend, CI/CD, cost controls, all of it.
- **Marketing** — AI plays the game, clips the moments, drafts the captions; I approve and it publishes. ([AI as my marketing intern](/devlog/).)

If it's a system, a script, a pipeline, or a deploy, AI is on it. That's not a compromise — for a solo dev it's a force multiplier that turns one person into a studio.

## What it never touches

The art. The music. The typography. The design decisions that give the game a soul, and the voice these devlogs are written in.

Every sprite, every track, the custom typeface on the title screen — made by hand. When I wanted the title clouds to drift and subtly shift, AI helped me write the *shader*; the clouds themselves were painted ([the shader breakdown](/devlog/a-shader-in-service-of-the-painting/)). That's the pattern everywhere: AI builds the machine that shows the art; it never makes the art.

## Why I draw the line there

Because the thing I'm actually selling is authorship. A 1990s-RPG feel isn't a checklist of features — it's a thousand small human choices about color, melody, pacing, and restraint. Hand those to a generator and you get something that looks like the genre and feels like nothing. The craft *is* the product.

So I let AI take everything that's leverage and keep everything that's voice. AI gives me the team. I keep the hands.
