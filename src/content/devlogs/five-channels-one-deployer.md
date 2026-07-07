---
title: "Five Channels, One Deployer: Shipping a Browser Game Without Touching It"
description: "How The Chronicles of Nesis goes from a git push to a playable browser build — channels, refusal gates, edge-enforced paid content, and a service worker with trust issues."
pubDate: 2026-07-07
category: "engineering"
devlog: "studio"
tags: ["deploy", "godot", "wasm", "cloudfront", "infrastructure"]
draft: true
---

I ship The Chronicles of Nesis to the browser several times a day, and most of
the time I don't do anything. A build finishes on the game side, a marker file
appears, a daemon on my machine notices, and ninety seconds later the new build
is live on a CDN — verified, cache-busted, and announced to the site without a
single commit. When it goes wrong, it refuses loudly instead of shipping
quietly. This post is about the machine that does that: five build channels,
one deployer script, and the specific scars that shaped each piece.

## Why five builds of one game

A playable web build turns out to want to be *several* builds. Players need a
clean, free **Demo**. Patrons at the Initiate tier get **Beta** content —
zones beyond what the Demo carries. I need **debug** variants of both (test
hooks, a debug HUD, save import — things players should never see). And the
bleeding edge needs somewhere to live: **develop**, rebuilt from every gated
build of the develop branch, so I can play what the team* built an hour ago.

(*"team" being AI agents, but that's other posts.)

So: a content axis (Demo vs Beta) times a debug axis, plus develop. Each
channel is just a path on the CDN — `/godot/public/`, `/godot/beta/`,
`/godot/develop/` and so on. The part I got wrong at first was putting the
list of *available* channels in source code. Flipping a build live meant a
commit, a site rebuild, a deploy — for a boolean. Now availability is
published at **runtime**: every deploy merges itself into a tiny
`channels.json` on the CDN, and the version picker on the site fetches it.
Deploying a build *is* announcing it. Nothing else to do.

## One deployer, many refusals

Every channel ships through the same script, and the interesting parts are
the ways it says no:

- **No `--promote`, no live deploy.** The two dev channels deploy freely; the
  three player-facing ones physically require a flag that the automated lane
  never passes. The worst an unattended bad build can do is break the channel
  only I can see.
- **A manifest that doesn't add up is a refusal**, not a warning: failed test
  gate, mixed-build timestamp skew, or a SHA-256 mismatch between the manifest
  and the bytes on disk (which usually just means the build was mid-rewrite —
  wait for the next one).
- **A live build with an unmasked script-encryption key is a refusal.** The
  key gets XOR-masked inside the WASM with a tiny un-masking shim injected at
  the loader — if that step didn't happen, the deployer assumes something
  changed underneath it and stops.

Refusal-by-default sounds slow and is the opposite. Because every gate is
mechanical, the happy path needs no judgment, which means it needs no *me*.

## A tier menu is not a lock

The version picker shows locked channels as an upsell — Beta greyed out with
"Initiate+". That check runs in the browser, which means it's marketing, not
security: the CDN serves `/godot/beta/` to anyone who types the URL, and
no amount of client-side JavaScript changes that.

Paid content gets two real gates, both server-side. Gated zone packs live in a
**private bucket** and are only reachable through a little endpoint that
checks your tier and hands back a presigned URL that dies in fifteen minutes.
And the Beta build itself now sits behind **CloudFront signed cookies**: a
Lambda verifies your membership — against the database, not your token, so a
lapsed subscription actually lapses — and issues cookies that the CDN edge
demands on every asset fetch. The webapp decides what to offer; the edge
decides what to serve.

One gotcha worth stealing: my CDN rewrites 403s into a friendly 200 page,
like most single-page-app setups do. Which means you can never verify a gate
by status code — "is it locked?" gets answered 200 either way. My smoke test
had to learn to sniff the response body for actual engine markers instead.
If your distribution has custom error pages, yours does too.

## The service worker will serve you a corpse

Every caching rule in my service worker is a memorial to a specific outage.
The game is ~75 MB; caching it is the difference between "instant second
visit" and "mobile users leave". But a cache that outlives its build serves
mismatched bytes, and a Godot engine fed a stale pack against a fresh
index.html doesn't error — it hangs on a loading screen forever.

Current doctrine, three incidents later: cache-first **only** for requests
that are self-versioned (`?v=` in the URL) or immutable-per-build (the WASM
and pack files); *everything* else under the game path revalidates on every
load. The cache name is keyed on the committed game version, and the deploy
tooling makes "committed version == deployed version" an invariant — the one
time those drifted, returning players hung on boot and the fix became a
script. There's also a watchdog on the play page that, if the engine sits
silent too long, assumes the cache is wedged, nukes it, and reloads. It fires
rarely. It has never fired for no reason.

## Deploys that prove themselves

The last step of every deploy is a headless browser actually *playing the
deployed bytes*: load the channel top-level, wait for the engine to report a
scene, scan the captured console for the four log signatures that mean a
build is dead (MD5 mismatches, encrypted-file failures). Live promotes get
the full version — cookie flow included for Beta, plus a check that the
deployed service worker matches the committed version. Dev-channel deploys
get a lighter boot-only pass, and a failure writes the same marker file the
build system already watches, so a broken develop build tells on itself.

Then CI does it all again after every site deploy, across Chromium and WebKit
on two OSes, including starting a NEW GAME and moving the player — because
"boots to title" and "playable" are different claims. The results land on a
dashboard, but honestly the marker files are the interface I actually read.

## What deliberately stays manual

Exactly one thing: promoting to a live channel. It's one command, it chains
the cache-safety commit and the changelog regeneration so I can't forget
them, and it runs the full smoke before I walk away. Everything else — dev
deploys, availability, verification, failure reporting — happens without me.

That's the actual thesis. Automation for a solo studio isn't about speed;
it's about what I no longer have to *remember*. Every rule in this post used
to be a thing I knew. Now it's a thing that refuses.
