---
title: "Painting Around the Grid: Pre-Rendered Backgrounds in a Tactical RPG"
description: "Pre-rendered backgrounds nearly died with the PS1 — bringing them back was part of the vision, not a compromise. Hand-painted fixed-camera scenes for a tactical RPG you can actually explore: how I fake 3D depth on a flat painting, and why that depth is the one thing a tactical grid can't sit on."
pubDate: 2026-06-24T15:00:00Z
category: "craft"
devlog: "chronicles"
tags: ["art", "tactical-rpg", "pre-rendered", "level-design", "godot"]
draft: true
---

Almost nobody ships pre-rendered backgrounds anymore. They were everywhere on the PS1 — Final Fantasy VII through IX, the early Resident Evils — a static 2D backdrop with real-time characters composited on top. The moment hardware could render 3D in real time, the technique was dropped as the stop-gap it had been. The usual epitaph: fixed camera, can't change anything mid-scene, enormous to store.

Dropping them was a loss — and I'm not the only one who thinks so. There's a real, lasting appetite for what those backdrops did; people still go back to FF7's prerendered cities and the painted halls of early Resident Evil for the way they *look*. Bringing that back was deliberate, and it was part of the vision from the start — not a compromise I settled into.

What I wanted was the *beauty* of a pre-rendered backdrop — the composed, painterly stillness the PS1 RPGs spent their whole graphics budget on — fused with something I rarely see in tactical RPGs: a *world to explore*. The genre tends to run mission-to-mission — pick a battle off a map, fight it, pick the next — without a place you actually wander. I wanted the tactics to live inside a real, walkable world of towns and dungeons, with the seamless flow of Chrono Trigger carrying you between exploring and fighting.

This post is about what makes that world renderable — the pre-rendered backgrounds and the tactical grid — and why the fixed camera everyone retired is exactly what lets a painted frame and a tactical board fit together.

<figure style="margin: 1.25rem 0;">
  <video controls autoplay loop muted playsinline preload="metadata" width="100%" style="border-radius: 6px; display: block;">
    <source src="https://allbyte.studio/captures/recordings/town-tour-laria.mp4" type="video/mp4" />
  </video>
  <figcaption style="text-align: center; font-size: 0.85rem; opacity: 0.7; margin-top: 0.4rem;">A wander through the sleepy starting village — parallax and hand-painted, pre-rendered backgrounds.</figcaption>
</figure>

## The fixed camera was never the weakness

The thing about a fixed camera is that the player *looks* at the frame. Not for the half-second a moving 3D camera grants before it pans away — for as long as they're in that room. Resident Evil understood this and leaned into it: a set camera let the directors compose each shot for exactly the tension they wanted. The static frame isn't a constraint you tolerate, it's a frame you get to author.

Mine aren't 3D scenes rendered down to 2D, which is what "pre-rendered" technically meant. They're **hand-painted**. That's more control, not less — there's no rig, no render, no lighting bake between me and the image. I paint the exact frame I want.

## The catch: I'm composing the grid at the same time

Here's the part no general history of pre-rendered backgrounds gets to, because they're not about tactics games: **I'm not just painting a dramatic angle, I'm painting the board a tactical grid has to play on — at the same time.**

I paint against a reference layer for grid placement and angle. So the composition and the playable space are authored together, in one pass: the most dramatic frame *and* a tactical grid that sits cleanly on it are the same decision. Drama and readability don't get traded off, because they were never separate steps.

A real-time 3D tactical game structurally can't do this. Its camera rotates, so the grid has to read from every angle and the scene can't be hand-tuned to any one of them. Committing to a single frame is exactly what lets me tune both at once.

<figure style="margin: 1.25rem 0;">
  <video controls autoplay loop muted playsinline preload="metadata" width="100%" style="border-radius: 6px; display: block;">
    <source src="https://allbyte.studio/captures/recordings/combat-transition.mp4" type="video/mp4" />
  </video>
  <figcaption style="text-align: center; font-size: 0.85rem; opacity: 0.7; margin-top: 0.4rem;">Into combat: the tactical grid drops onto the painted ground and the battle begins.</figcaption>
</figure>

## Faking depth on a flat painting

A pre-rendered backdrop is dead flat — it's a picture. But walk around one of my scenes and it reads like a space you move *into*, not just across. That's a deliberate mechanic — I call it the depth-of-field system (no relation to the camera-lens kind) — and it's cruder than it looks.

<figure style="margin: 1.25rem 0;">
  <video controls autoplay loop muted playsinline preload="metadata" width="100%" style="border-radius: 6px; display: block;">
    <source src="https://allbyte.studio/captures/recordings/dwarven-ruin-entrance.mp4" type="video/mp4" />
  </video>
  <figcaption style="text-align: center; font-size: 0.85rem; opacity: 0.7; margin-top: 0.4rem;">The Dwarven Ruin entrance — depth of field running the whole scene: shrink, slow, and the pull toward the vanishing point.</figcaption>
</figure>

Each scene can carry a perspective zone: a box I lay over the painted ground, its bottom edge "near," its top edge "far," aimed at a vanishing point on the painting's horizon. While you're inside it, the game measures how deep you are — a straight 0-to-1 ratio from the front of the box to the back — and uses that one number to blend two things between their near and far values:

- **Scale** — you shrink as you head back.
- **Speed** — you move slower the deeper you go (the wading-into-the-distance feel).

(The same lerp can drive camera zoom too, but I rarely reach for it.)

Then your *path* bends toward the reference point — the spot I set for the painting's perspective to converge on, which isn't necessarily straight up the screen. Head toward it, deeper into the scene, and a sideways nudge pulls your line of travel in; move away and it fans back out — the exact convergence of walking a road that narrows to a point. Stack shrink + slow + drift-toward-that-point and a static painting becomes a space with a real *forward*.

It isn't real perspective math — it's a linear map on screen height, tuned per scene. That's the whole trick: I'm not computing a correct projection, I'm dialing the numbers to one specific painting until it feels right. Every scene gets its own box, its own near/far scale and speed, its own vanishing point — and it runs on the whole party, so trailing members shrink and tighten their spacing as the line recedes.

It's fragile in instructive ways, too. The Godot 3→4 jump silently flipped the sign of the angle function the drift relies on, and suddenly walking up the hill out of the church square shoved the lead character *left* instead of right — same line of code, opposite result. (It was [one of the silent renames I wrote about](/devlog/godot-3-to-4-retrospective/).)

## The hard part: a grid can't live on that depth

That depth is exactly what a tactical grid can't tolerate — and it's the constraint that decides, before I lay down a brushstroke, whether a scene can even have combat.

A tactical grid is a roughly flat plane of cells. For the cells to stay consistent, every point of the playable ground has to sit **roughly the same distance from the camera** — a high enough, angled enough view that foreshortening across the board is near-uniform. The moment a scene leans hard on perspective — ground receding toward a far vista, a big foreground — that uniformity breaks and the flat grid stops matching the painted ground.

So depth becomes a design lever, not a free choice:

- **Laria's Main Square** has only a little — small enough that the ground stays roughly equidistant, so it keeps its grid and supports combat.
- The **Dwarven Ruin entrance** is the opposite: the depth is the *whole scene*, the entire frame plunging inward. There's no honest way to lay a flat grid on that — so I made it a non-combat scene. The drama is the point, and combat would have to give it up.

When you try to force the two together, the failure surfaces at interaction time: a unit snaps to the nearest cell to reach an enemy, and if that move crosses real painted depth, the unit appears to **jump across depth to a cell that reads wrong** — the math is right, the picture disagrees.

So the rule I paint by: dramatic depth is reserved for set-piece, non-combat scenes; anywhere a grid has to live, the camera height keeps every point roughly equidistant and the board stays a board. Painting *around* the grid — knowing which scenes get to be dramatic and which have to stay honest — is most of the discipline.

## How it goes together in-engine

The game runs in Godot 4. Each battle scene is a fixed camera over the hand-painted backdrop. The grid is isometric, fit to that specific painting's angle, with the move/attack/confirm highlights all sharing the same cell transform so they land exactly on the painted ground. Units are drawn into the scene with y-sorting, so a character lower on screen overlaps one behind them — cheap pseudo-depth that sells real-time sprites standing in a static painting. Everything renders pixel-crisp (nearest-neighbor), so the brushwork stays sharp at any zoom. Out in the overworld, where there's no grid, I let the depth loose: parallax layers, drifting clouds, the whole frame breathing.

## Why bother

Because the constraint *is* the craft. A near-dead technique, judged purely on fidelity, lost to real-time 3D years ago. But judged on what a tactical RPG actually needs — a readable board, a composed frame, a fixed angle you can hand-tune art and rules onto together — it isn't a throwback. It's the right substrate, and the discipline of painting around the grid is what makes the board both beautiful and playable at once.
