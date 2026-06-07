---
title: "AI as My Marketing Intern"
description: "I'm a solo developer building a tactical RPG. I can't realistically do social media at the cadence platforms reward. So I built a pipeline: AI plays my game, AI clips the interesting moments, AI drafts the captions, I approve, my self-hosted scheduler publishes. Here's what it produces."
pubDate: 2026-06-07T00:00:00Z
category: "engineering"
devlog: "studio"
tags: ["marketing", "automation", "ai", "postiz", "self-hosting"]
draft: true
---

The math for indie marketing doesn't work without automation.

YouTube Shorts rewards 7-14 clips per week. Bluesky and Mastodon want roughly a post per day. Discord wants announcements when there's news. I'm one person. If I do this manually, I'm not making the game I'm trying to market.

So I built a pipeline. AI plays the game, AI picks the interesting moments, AI drafts the captions, I approve, a self-hosted scheduler publishes. The clip embedded below is one such moment. The Discord post that announced it landed in my server via the same pipeline that produced the clip.

<!--
  REPLACE the embed below with the YouTube video ID after you upload the
  cond_11 Waterway combat clip (clip_002 from this session — ~32s at
  1080p/60fps). The current placeholder will not load.
-->
<iframe width="100%" height="400" src="https://www.youtube-nocookie.com/embed/REPLACE_WITH_YOUTUBE_ID" title="The Chronicles of Nesis — AI-driven gameplay capture" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="border-radius: 6px; margin: 1rem 0;"></iframe>

## The pipeline

1. **A virtual player runs the game.** An AutoPlay system inside The Chronicles of Nesis drives the character through scenes, fights enemies, and talks to NPCs. (More on AutoPlay and the walkthrough generation it enables in [another post](/devlog/) — coming.)
2. **A capture harness records the session** at 1080p / 60fps on my host, listening to the game's console output for combat events, scene transitions, and skill usage. Output: an MP4 plus a structured timeline JSON. (More on how the capture environment got there in [another post](/devlog/) — coming.)
3. **A clip extractor turns the session into highlights.** Time-clusters of combat events become per-cluster 5-60 second MP4s with thumbnails.
4. **A caption drafter writes platform-specific copy.** Each clip's metadata goes to Claude through the same CLI I use for development — title, Bluesky variant, Discord variant, YouTube Shorts variant — and writes back into the per-clip JSON. The brand voice lives in the system prompt and stays consistent across drafts.
5. **A review queue surfaces what's drafted.** A page on my dev console shows the latest capture's clips with editable caption fields. I scan, occasionally tweak, click publish per platform.
6. **Postiz publishes.** Self-hosted, AGPL, has a CLI my dev server shells out to. The post lands in the target channel within seconds.

<!--
  TODO: screenshot of the marketing-queue UI (/test/marketing-queue/)
  showing 2-3 clips with thumbnails and editable captions.
  Suggested filename: marketing-queue-with-clips.png in marketingImages/
-->
![The review queue with AI-drafted captions](/marketingImages/marketing-queue-with-clips.png)

## Why self-hosted

SocialBee costs $29-49 a month and is a polished product with a real "recycle" feature for evergreen content. It also doesn't talk to Claude, and it doesn't talk to my autoplay system. The whole shape of this pipeline is that AI is upstream — clipping, drafting, narrating — and the scheduler is downstream. SocialBee assumes a human upstream; my constraint is the opposite.

Postiz is open source, runs in a container alongside my dev environment, and exposes its API through a CLI that my middleware shells out to. So that's what I picked. Saves $29 a month, removes a SaaS dependency, and matches the architectural direction I want to keep growing in.

<!--
  TODO: screenshot of the published post in Discord (from your server).
  Suggested filename: discord-published-post.png in marketingImages/
-->
![The same clip, published to Discord by the pipeline](/marketingImages/discord-published-post.png)

## What handcrafted means here

The pipeline is engineering work: capture, encode, draft, schedule, publish. AI is the right tool for that.

The game's art, music, and typography are handcrafted by me. The pixel art, the soundtrack, the custom typeface that's on the title screen. The pipeline writes captions about them and picks moments that showcase them. It doesn't make them.

## Where this leaves me

I press a button. A 3-minute capture produces between 1 and 5 clips depending on combat density, each with a thumbnail and a draft caption. I scan the queue, occasionally tweak a caption to sound more like me, and click publish to Discord. From "press Capture" to "post is live" is about 5 minutes, almost all of which is the game playing itself.

This devlog is the same kind of artifact. The clip embedded above was captured, encoded, and uploaded via the same pipeline I just described. The Discord post announcing this post will land the same way.

I'll be doing the design work, the art, the music, and the writing-for-voice. The intern handles the rest.
