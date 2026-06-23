---
title: "AI as My Marketing Intern"
description: "I'm a solo developer building a tactical RPG. I can't do social media at the cadence platforms reward, so I built a pipeline: AI plays my game, AI clips the moments, AI drafts the captions, I approve, my self-hosted scheduler publishes. Then I ran it across every platform for a real launch — and learned which ones fight back."
pubDate: 2026-06-22T12:00:00Z
category: "engineering"
devlog: "studio"
tags: ["marketing", "automation", "ai", "postiz", "self-hosting"]
draft: true
---

The math for indie marketing doesn't work without automation.

YouTube Shorts rewards 7-14 clips per week. Bluesky and Mastodon want roughly a post per day. Discord wants announcements when there's news. I'm one person. If I do this manually, I'm not making the game I'm trying to market.

So I built a pipeline. AI plays the game, AI picks the moments, AI drafts the captions, I approve, a self-hosted scheduler publishes. The clip below is the title screen of *The Chronicles of Nesis* — the first thing the pipeline cut and shipped for the game's web launch. It was captured, encoded, scored with the main theme, and pushed to four platforms by the same machine described in this post.

<video controls preload="metadata" width="100%" poster="/og-image.jpg" style="border-radius: 6px; margin: 1rem 0;">
  <source src="https://allbyte.studio/captures/recordings/capture-20260622-title-screen.mp4" type="video/mp4" />
</video>

## The pipeline

1. **A virtual player runs the game.** An AutoPlay system inside The Chronicles of Nesis drives the character through scenes, fights enemies, and talks to NPCs — or, for a showcase shot like the title screen above, just holds on a scene while the camera and shaders do the work.
2. **A capture harness records the session** at 1080p / 60fps on my host — invisibly, straight from the browser's compositor, so it never takes over my screen — listening to the game's console output for combat events, scene transitions, and skill usage. Output: an MP4 plus a structured timeline JSON.
3. **A clip extractor turns the session into highlights.** Time-clusters of combat events become per-cluster 5-60 second MP4s with thumbnails. (A showcase capture becomes a single clip, the way the title reel did.)
4. **A caption drafter writes platform-specific copy.** Each clip's metadata goes to Claude through the same CLI I use for development — a title, a Bluesky variant, a Mastodon variant, a Discord variant — and writes back into the per-clip JSON. The brand voice lives in the system prompt and stays consistent.
5. **A review queue surfaces what's drafted.** A page on my dev console shows the latest capture's clips with editable caption fields. I scan, occasionally tweak, approve.
6. **Postiz publishes.** Self-hosted, AGPL, with a CLI my dev server shells out to. The post lands in the target channel within seconds.

![The capture queue — the game's beats the pipeline can record on demand, from the intro through the Mother Slime boss](/marketingImages/marketing-queue-with-clips.png)

## What launch day actually taught me

Building the pipeline was the easy part. Wiring it to real platforms and pressing publish for an actual launch is where the truth came out. Every walled garden fought back in its own way:

- **Threads wouldn't fetch my video.** Meta ingests video by pulling the file from a URL on *its* servers — and it refused to pull from the private tunnel my scheduler sits behind. The fix was to serve the clip from my own domain instead. Once the file lived somewhere Meta would reach, the video posted on the next try.
- **X won't post at all on the free API tier.** Not just media — anything. Even a plain-text post is rejected by the free tier's write endpoint. The choices are to pay for a much higher tier or post by hand. For a secondary channel, I post by hand.
- **TikTok needs an audit before it reaches anyone.** A new app lives in a sandbox where posts are private to you until TikTok reviews a recorded demo of the integration. That's its own small project, and TikTok rewards vertical, rough, process-style clips anyway — not a polished title card. So it waits.
- **Bluesky, Mastodon, and Discord just worked.** Native video, first try, no fighting.
- **Link previews don't happen by accident.** My site shipped with no Open Graph tags, so a shared link rendered as a bare URL. A handful of meta tags later, every link posts as a proper thumbnail card.

The pattern is the one the rest of my stack keeps teaching, now applied to distribution: the open, self-hostable channels cooperate, and each closed platform charges a tax — a paid tier, an audit, an infrastructure workaround. So the pipeline drives the channels that let it, and the rest get a quick copy-paste by hand.

## Why self-hosted

A managed scheduler costs $30-50 a month and is a polished product. It also doesn't talk to Claude, and it doesn't talk to my autoplay system. The whole shape of this pipeline is that AI is *upstream* — clipping, drafting, narrating — and the scheduler is downstream. A SaaS tool assumes a human upstream; my constraint is the opposite.

Postiz is open source, runs in a container alongside my dev environment, and exposes its API through a CLI my middleware shells out to. So that's what I picked. It removes a subscription, removes a vendor, and matches the architectural direction I want to keep growing in.

## What handcrafted means here

The pipeline is engineering work: capture, encode, draft, schedule, publish. AI is the right tool for that.

The game's art, music, and typography are made by me — the sprites, the soundtrack, the custom typeface on that title screen. The pipeline writes captions about them and picks the moments that show them off. It doesn't make them.

## Where this leaves me

I press a button. A capture produces clips with thumbnails and draft captions; I scan the queue, tweak a line to sound more like me, and approve. The scheduler fans it out to every channel that allows automation, and I spend two minutes hand-posting the few that don't.

This devlog is the same kind of artifact: the clip above was captured, encoded, and published by the pipeline it describes. I do the design, the art, the music, and the writing-for-voice. The intern handles the rest.
