---
title: "From Git Push to Playable: The Whole Web-Deploy Machine"
description: "The CI/CD pipeline that takes The Chronicles of Nesis from a git push to a playable browser build with nobody driving — hermetic cloud export on CodeBuild, five channels, refusal gates, edge-enforced paid content, one version number everything obeys, and a service worker with trust issues."
pubDate: 2026-07-11
category: "engineering"
devlog: "studio"
tags: ["deploy", "godot", "wasm", "cloudfront", "cicd", "infrastructure"]
draft: true
---

I ship The Chronicles of Nesis to the browser several times a day, and most of
the time I don't do anything. Someone pushes to a branch, a container I never
see builds the game from scratch, and a couple of minutes later the new build
is live on a CDN — verified, cache-busted, version-locked, and announced to the
site without a single extra commit from me. When it goes wrong, it refuses
loudly instead of shipping quietly. This post is about the whole machine that
does that: a hermetic cloud build, five channels, one deployer script, a single
version number that everything else has to obey, and the specific scars that
shaped each piece.

Under the vocabulary I use for it here — "the machine," "refusals,"
"channels" — it's an ordinary **CI/CD pipeline**: a git push goes in, a verified
deployment comes out, and nobody sits in the middle. What earns it a post is
everything a *game engine* drags into that pipeline that a web service never has
to think about — a ~75 MB WebAssembly payload, a service worker that will
happily serve a corpse, a decryption key the client can't avoid carrying, the
cross-origin-isolation headers the browser demands before it will even run the
thing. The shape is industry-standard. The problems are not.

## The build I don't run

A push to the game repo's `develop` branch fires a webhook at **AWS CodeBuild**.
A container I never see clones the repo clean, runs a headless Godot 4 export
against a template that already has the script-encryption key compiled in, and
hands the result to the exact same deployer I used to run by hand. That's the
continuous-deployment half of the loop in one sentence: commit in, verified
build out, no laptop in the path.

It didn't start in the cloud. The first version ran a little daemon on *my*
machine, watching for a marker file the game build dropped and running the
export locally — which quietly tied "is the develop channel current?" to "is my
laptop awake?", a terrible thing to couple. Moving the build into CodeBuild cut
that cord. Now there's no shared state with any machine I own; the only inputs
are the commit and a pinned toolchain image. If it builds on my laptop but not
in there, my laptop was lying — which is the entire point of building it
somewhere I can't touch.

That toolchain image is pinned to an exact published version, not a floating
"latest" tag, because the one time it floated, a rebuild silently shipped a
**stale export** and the channel booted straight into the WASM equivalent of a
segfault — Godot's cheerful *"memory access out of bounds."* So the CI job that
builds the image also advances the build's pin to the precise image it just
published, in the same run, atomically. Reproducible or it doesn't ship, and a
pin that doesn't match is one more refusal.

## Why five builds of one game

A playable web build turns out to want to be *several* builds. Players need a
clean, free **Demo**. Patrons at the Initiate tier get **Beta** content —
zones beyond what the Demo carries. I need **debug** variants of both (test
hooks, a debug HUD, save import — things players should never see). And the
bleeding edge needs somewhere to live: **develop**, rebuilt from every gated
build of the develop branch, so I can play what the team* built an hour ago.

(*"team" being AI agents, but that's [other posts](/devlog/two-claudes-to-five/).)

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
- **A live build whose script-encryption key hasn't been obfuscated is a
  refusal.** Godot carries that key inside the WASM (as every web export does);
  a build step scrambles it on disk to deter casual static extraction, and if
  that step didn't run, the deployer assumes something changed underneath it
  and stops.

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
And the Beta build itself sits behind **CloudFront signed cookies**: a
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

Current doctrine, several incidents later: cache-first **only** for requests
that are self-versioned (`?v=` in the URL) or immutable-per-build (the WASM
and pack files); *everything* else under the game path revalidates on every
load. There's a watchdog on the play page that, if the engine sits silent too
long, assumes the cache is wedged, nukes it, and reloads. It fires rarely. It
has never fired for no reason.

And a deploy that uploads new bytes but forgets to *invalidate the CDN* is
just a slower stale-cache bug — so the invalidation target gets handed to the
build as an environment variable, not looked up at runtime. (The build role is
scoped down so tightly it can't even read the CDN's own ID; the first time it
tried to discover it at runtime and lacked permission, it skipped the step in
silence and served yesterday's game from the edge. Now it can't skip what it's
already been told.)

## One version number, everywhere or nowhere

There is a single committed source of truth for "what build is this" — a
`game-version.json` file — and a surprising number of things have to agree
with it or the whole system wedges. The service worker keys its cache name on
it. The picker shows it. The changelog is generated from it. And the service
worker file itself gets *stamped* with it at deploy time.

The failure that made me build all of this: if the committed version is
*older* than the bytes actually sitting on the CDN, the service worker decides
its stale cache is current, serves it, and returning players hang on boot
forever — while a brand-new visitor sees a perfectly healthy game. It's the
worst kind of bug, invisible to the exact person testing it. So promoting a
live build doesn't just upload files; it re-stamps `game-version.json` to the
version it actually deployed, regenerates the changelog, and commits that —
which in turn makes CI re-stamp the service worker to match. "Committed equals
deployed" isn't a discipline I keep; it's a step that runs whether I remember
it or not, and the prod smoke test refuses to pass if the two ever drift.

## Deploys that prove themselves

The last step of every deploy is a headless browser actually *playing the
deployed bytes*: load the channel, wait for the engine to report a live scene,
and scan the captured console for the handful of log signatures that mean a
build is dead — MD5 mismatches, encrypted-pack failures, the boot-loop errors.
A build that compiles cleanly and then crashes on load is precisely the thing
"did it build?" can't catch, so I stopped trusting "did it build?"

The part I'm proudest of is that this now runs *inside* the cloud build. I
baked a headless Chromium into the exporter image so CodeBuild can open its own
deploy in a browser before declaring victory — which means a develop build that
doesn't boot **fails the build**, in the cloud, unattended. No green checkmark
over a black screen. Live promotes get the fuller version: the paid-content
cookie flow, and the check that the deployed service worker version matches the
commit.

Then CI does it *again* after every site deploy, across Chromium and WebKit on
two operating systems, including starting a NEW GAME and moving the character —
because "boots to a title screen" and "playable" are different claims, and I
have shipped the first while breaking the second.

## What deliberately stays manual

Exactly one thing: promoting to a live channel. It's one command, it chains
the cache-safety re-stamp, the changelog regeneration, and the commit so I
can't forget them, and it runs the full smoke before I walk away. Everything
else — the dev builds, the export, availability, verification, failure
reporting — happens without me.

That's the actual thesis. Automation for a solo studio isn't about speed; it's
about what I no longer have to *remember*. Every rule in this post used to be a
thing I knew. Now it's a thing that refuses.

## You can point it at your own game

None of this is locked up. The site you're reading is
[open source](https://github.com/allbytestudios/allbyte-web), MIT-licensed —
every script this post names is in that repo: the one deployer, the key
obfuscator, the boot-smoke check, the service worker, the version-stamping. Not
a diagram of the machine. The machine.

And almost none of it is specific to *my* game. The five-channel model, the
refusal gates, the version-locked service worker, the self-proving boot check,
the hermetic cloud export — those are Godot-web problems, not Chronicles
problems, and the code that solves them doesn't know or care what game it's
shipping. The bits that *are* mine — bucket names, the CloudFront distribution,
the encryption key — are configuration and inputs, never hardcoded, precisely so
a fork leaks nothing and swaps cleanly.

So if you're a Godot dev who wants a real web build — not a jam-game iframe, but
something cache-correct, resistant to casual ripping, and self-verifying — you wouldn't
copy my AWS account. You'd point the config at your own private game repo, wire
the build to plain GitHub Actions instead of the CodeBuild project I happen to
use, and keep the rest. It's the reference implementation; my game is just
customer number one. I've resisted turning it into a polished product with a
landing page — that's a whole separate project — but the working version is
already public, and "read the actual scripts that ship a browser game every day"
beats a tutorial that rots.

That's the part I didn't expect when I started: the machine turned out to be as
much the thing I'm making as the game is. (On *why* I'd rather own a machine like
this outright than rent the equivalent from a platform, there's
[a whole other post](/devlog/pay-the-platforms-or-own-the-stack/).)
