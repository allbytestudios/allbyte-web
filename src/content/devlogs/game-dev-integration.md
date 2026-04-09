---
title: "Integrating the Website with the Game"
description: "How game assets flow from the Godot project to the web — asset sync, sprite conversion, and lessons learned building the pipeline."
pubDate: 2026-04-08T00:01:00Z
category: "technical"
devlog: "studio"
tags: ["godot", "assets", "pipeline", "aws", "self-hosting"]
---

The web portal isn't just a marketing page — it's a live window into the game. Music, sprites, and backgrounds are pulled directly from the Godot project and served through the site. This post covers how game assets flow from the development environment to the web.

## Asset Sync

Game assets (music, sprites, fonts, backgrounds) are **not committed to git**. All art is handcrafted and I don't want it easily ripped from a public repo. Instead, assets are synced locally from the Godot project and pushed directly to S3.

The workflow is three steps:

1. `npm run sync` — pulls assets from the local Godot project into `public/assets/` (gitignored)
2. `python scripts/spritesheet-to-gif.py` — converts sprite sheets to animated GIFs
3. `npm run push-assets` — uploads everything to S3 with immutable cache headers

A Node.js sync script (`scripts/sync-assets.js`) reads a manifest (`scripts/asset-manifest.json`) and handles music dedup (prefers `.ogg`, skips format duplicates), font and background copying, and version extraction from the Godot source.

The CI deploy only syncs the site build (HTML/CSS/JS) and explicitly excludes asset paths from its `--delete` flag, so assets uploaded separately are never removed. Only JSON metadata indexes are committed to git — file paths and character data that the Astro pages consume at build time.

## Sprite Conversion

Sprites are the interesting part. The game stores character animations as horizontal sprite sheets — a single PNG with all frames side by side. A Python script splits these into individual frames and assembles animated GIFs, scaled up with nearest-neighbor interpolation to keep pixel art crisp.

The script auto-deduplicates identical sprites within a character and supports per-sheet frame width overrides for non-square animations (like casting poses). Characters can be flagged as `hidden` for unreleased content.

This pipeline will grow as the devlog system is fully built out — eventually, game updates will automatically surface new content on the site.
