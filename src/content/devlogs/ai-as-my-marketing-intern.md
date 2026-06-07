---
title: "AI as My Marketing Intern"
description: "I'm a solo developer building a tactical RPG. I can't realistically do social media at the cadence platforms reward. Here's the pipeline I built: AI plays my game, AI clips the interesting moments, AI drafts the captions, I approve, Postiz publishes. Self-hosted end-to-end."
pubDate: 2026-06-07T00:00:00Z
category: "engineering"
devlog: "studio"
tags: ["marketing", "automation", "ai", "postiz", "capture", "ffmpeg", "self-hosting"]
draft: true
---

The math for indie marketing doesn't work without automation.

A platform like YouTube Shorts rewards 7-14 clips per week. Bluesky and Mastodon reward roughly one post per day. Discord wants announcements when there's news. I'm one person. If I do this manually, I'm not making the game I'm trying to market.

So I built a pipeline. It plays the game for me, picks the interesting moments, writes captions for each platform, and publishes when I click approve. I built every layer of it myself, on my own machine, on rented compute I control. Here's what it does and how it came together.

## The shape

1. **A virtual player runs the game.** An AutoPlay system inside The Chronicles of Nesis (the tactical RPG I'm building) drives the character through scenes, fights enemies, talks to NPCs. It's the same AI infrastructure I use for end-to-end testing — capture is just one more consumer of it.

2. **A Playwright harness records the session.** It launches the game in a real browser on my host, recording the screen at 1080p 60fps via ffmpeg, while listening to the game's console output for combat events, scene transitions, and skill usage. Each session writes an MP4 plus a structured timeline JSON.

3. **A clip extractor turns the session into highlights.** It clusters combat events by time, cuts each cluster as its own 5-60 second MP4 with a thumbnail, and writes per-clip metadata. The full session stays around so I can re-cut later with different heuristics if I want.

4. **A caption drafter writes the platform-specific copy.** It feeds each clip's metadata to Claude (via the Claude Code CLI, so it consumes my existing subscription instead of paid API calls) and gets back a title, a Bluesky variant, a Discord variant, and a YouTube Shorts variant. The brand voice — first-person solo dev, handcrafted-art identity, no overclaiming — lives in the system prompt and stays consistent across drafts.

5. **A review queue surfaces the clips.** A page on my dev console (`/test/marketing-queue/`) shows the latest capture with its clips and AI-drafted captions in editable text areas. I review, edit if I want, and click publish per platform.

6. **Postiz publishes the post.** Self-hosted, AGPL, has a Claude-friendly CLI. The middleware on my dev server fires `postiz posts:create` with the chosen caption and clip URL. The post lands in the target channel within seconds.

7. **A second click promotes the clip to artwork.** Approved clips get copied to a durable S3 prefix and added to the `/artwork/` page's recordings gallery, where supporters can browse them. The post is the marketing surface; the gallery is the curated archive.

The whole stack is on commodity infra. The game is in S3. Postiz is in Docker on my machine. The capture script is a PowerShell wrapper around ffmpeg and Python. The Claude calls go through the same CLI I use for actual development. Nothing is on Postiz's cloud, nothing depends on a SaaS account I might lose.

## Why I built it myself instead of buying SocialBee

SocialBee costs about $29 a month for the entry tier, $49 for more channels. It has a real "Recycle" feature for evergreen content that's genuinely useful. It's a polished product.

It also doesn't talk to Claude, and it doesn't talk to my autoplay system. The whole premise of this pipeline is that the AI does the upstream work — clipping moments, drafting platform-aware captions — and a scheduler just publishes whatever I approve. SocialBee assumes a human is upstream feeding it content. My constraint is different: I'm only useful as the approver.

Postiz is open source, runs in a container next to my dev environment, and exposes its API through a CLI that Claude can shell out to natively. So that's what I picked. Saves me $29/month plus some lock-in, and matches how I want the pipeline shaped.

## The detour through Docker

The capture component started in a Docker container. The plan was: Linux base image, Xvfb virtual display, PulseAudio, ffmpeg, Playwright. Same container shape my QA infrastructure uses. Cross-platform, reproducible, ready to run in CI later.

It worked. The game booted, AutoPlay ran, ffmpeg recorded, the clips published. The clips were also at about 10 frames per second.

Mesa's software rasterizer can't keep up with Godot's WebGL workload under CPU rendering. I measured: at 1920x1080, the game ran at 1.1 fps; at 1280x720, 10.3 fps; at 640x360, 11.7 fps. Pixel count helped at 1080p but stopped mattering below 720p — the bottleneck shifted from pixel fill to per-frame compute. Godot's compositor has fixed cost per frame, and llvmpipe on a Xeon doesn't have the throughput.

I considered NVIDIA Container Toolkit for GPU passthrough. It would work. It's also another driver dependency, another piece of the stack that can break, and it only matters because I made the original choice to put this in a container in the first place.

I'm one person on Windows with a real GPU sitting in the same machine I'd run the container on. The container was for a hypothetical CI environment that doesn't exist. So I rewrote the orchestrator in PowerShell, dropped Xvfb and PulseAudio, used ffmpeg's `gdigrab` for video and `dshow` (against VB-Cable for clean Chromium-only audio), and ran Playwright headed on my actual desktop. Same `run.py` core, different OS plumbing.

The native pipeline measures at 60 fps median against the same cond_11 fixture. Six times faster. The Dockerfile and boot.sh stay in git history if I ever do need a CI version.

The lesson I want to remember: I added complexity I didn't need because I was reaching for a pattern that fit a future use case. The current use case wanted something simpler. The pattern was wrong for the moment.

## The Completionist persona

This is the piece that's still being built on the game side. Right now AutoPlay has a default persona (engages encounters by zone proximity) and a Scout persona (avoids encounters, retreats at low HP). Useful for QA, useful for combat capture. Not useful for a comprehensive walkthrough.

The new Completionist persona — Arc, the orchestrator on the game side, is building it — will exhaust the current chapter. Visit every scene, talk to every NPC, open every container, fight every enemy, read every sign. It stops when the story-progression counter can't advance further from the loaded save state.

When the Completionist runs against all 11 captured fixtures, the pipeline gets a complete play-by-play of every scene, every conversation, every encounter. That data — scene anchors, dialogue text, item discoveries, combat outcomes — feeds two things:

1. A published-style walkthrough page (Legend-tier perk, live at `/walkthrough/` once content lands). Chapters by story-progression count, with screenshots, area maps from the in-game minimap, dialogue excerpts, and combat strategy.
2. The marketing-post drafter. Right now Claude writes captions for whatever clip I throw at it. With the walkthrough as a structured knowledge base, the captions get to reference specific story beats, quote the right character, and connect to the right chapter. Marketing posts with substance, not just description.

The boundary between Arc and me, as I drew it: AutoPlay emits semantic events during traversal (scene-entered, dialogue, item-found, combat-resolved, chapter-boundary). My harness consumes those events plus the visual capture. AutoPlay never has to know about ffmpeg or S3 or `recordings.json`. My harness never has to know how the game decides what scene to load next. Each side owns what's already in its lane.

## What handcrafted means here

The pipeline is engineering — capture, encode, draft, publish. AI is the right tool for it.

The game's art, music, and typography are handcrafted by me. The pixel art, the soundtrack, the custom typeface that's on the title screen and in every menu. Those aren't where the AI goes. The marketing pipeline writes captions about them, picks moments that showcase them, schedules the posts. It doesn't make them.

## Where this leaves me

I press a button. A 3-minute capture session produces between 1 and 5 clips depending on combat density, each with a thumbnail and a draft caption. I scan the queue, occasionally tweak a caption to sound more like me, and click publish to Discord. From the time I press Capture to the time the post lands in my Discord server is about 5 minutes, almost all of which is the game playing itself.

Once the Completionist persona ships and I run a batch against every captured story chapter, the walkthrough page will fill in. Then the same pipeline that publishes individual clips will also draft devlogs about specific story moments, with the chapter as the source.

I'll be doing the design work, the art, the music, the writing-for-voice. The intern handles the rest.
