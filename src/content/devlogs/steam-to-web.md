---
title: "Steam to Web: The Day Job Meets the Dream"
description: "Why I'm spending my evenings building enterprise-grade infrastructure around a tactical RPG — and the moment I realized it might actually work."
pubDate: 2026-04-10T23:00:00Z
category: "technical"
devlog: "chronicles"
tags: ["chronicles-of-nesis", "ai", "claude", "playwright", "indie", "infrastructure"]
---

## AllByte

My day job is large-scale distributed systems engineering. Getting code to work together at scale — services, queues, observability, CI/CD, the whole apparatus that lets a hundred engineers ship a single product without stepping on each other.

The night project is [Chronicles of Nesis](https://store.steampowered.com/app/3900010/The_Chronicles_of_Nesis/) — a tactical RPG I've been building solo in Godot for four years. Pixel art, custom font, hand-built dialogue system, the whole 90s-JRPG aesthetic. It exists because I love it, not because it makes business sense.

These two have always been disconnected. Gamedev folks don't usually care about distributed systems. Distributed systems folks don't usually make games. Then about a month ago, I downloaded Claude.

## The Solodev

For a long time, the only way to make a solo indie game was to grind (and not the fun JRPG leveling up kind). Every line of code costs you an hour you don't have. You make trade-offs. You skip the test harness, skip the CI, skip the observability, skip the architecture diagrams — because the math doesn't work at solo scale. The same practices that make a hundred-engineer codebase tractable would crush a one-person codebase before the game ever shipped.

So you cut corners. You manually playtest. You write code that you can hold in your head because there's no other way to verify it. You ship a half-tested build to a closed beta and hope nobody finds the regressions you can't catch yourself. The discipline isn't wrong; it's just unaffordable. Or it used to be.

## The Feedback Loop

People have been asking me to download AI and code with AI for years. I always answered the same way: "I tried it, I get it, it helps you, but I can code it faster — and better." And I was right. Until I wasn't.

Code generation is fast now, but "fast" doesn't get the idea across. It's not that it's *faster*. It's…

I used to estimate time for very strong software engineers to complete things. I've shipped hundreds of apps, dozens of architecture stacks. I know how long it takes to build something, and how long it takes to build it right. The way I think about this now is: code generation that had to be hand-crafted ran on human time. Code generation went from human time to compute time. And if you know what a processor's clock speed is, you have an idea of what "fast" means now.

So fast that it has stopped being the bottleneck. In my opinion, the bottleneck has moved to two places: knowing what to ask for, and knowing whether you got it.

Both of those are things AI can also help with. But not for free. They each demand something specific:

- **Knowing what to ask for** demands a knowledgeable user. AI doesn't replace expertise; it amplifies it. The unknowledgeable user gets fluent-sounding garbage; the knowledgeable user gets a hundred junior engineers.
- **Knowing whether you got it** demands a tech stack and architecture where verification is cheap. Without that, you're back to manually verifying every little step, and the velocity gain evaporates inside an hour.

["Zero to Steam"](/devlog/from-zero-to-steam/) was the first chapter — four years of grinding the game itself into a shape worth shipping. Combat, isometric grids, dialogue, save system, controller support, the whole 90s tactical RPG vocabulary. The endgame of that era was the demo on Steam.

"Steam to Web" is the conclusion I came to after wracking my head on a different question: *OK, AI can write my code now — what do I actually do with that?* It started as "well, I have four years of a passion project sitting here, how do I aim AI at it?" Which became "I know what I'd need to make AI useful at this scale — a validation loop, fast enough to keep up with how fast the code is generated." Which became "the validation loop needs Playwright, but Playwright lives in browsers, and heavy browser games are notoriously difficult to build." And then — wait. "Difficult to build" was where I started… Claude.

But I've been using AI tools since the first ones were built — the early, rough ones — and I've watched the gap between *what AI can do* and *what AI can do for me* close one expectation at a time. This particular expectation has been on my mental list for almost two years and I couldn't even sketch the architecture, because the architecture didn't exist yet. Now it does. And the architecture matches almost exactly the kind of thing I build at work.

That's the moment I'm trying to describe. Not "AI is changing software." That's old news. The moment is: *the distance between my expertise and my dream just collapsed.*

## The Game

Chronicles of Nesis is the project, but the project is beside the point.

What the project gives me is a real codebase I care about, in a real engine, that exports to a real browser, that can be driven by real tooling. The experiment needs all four to be real or the lessons don't transfer to anything else.

The experiment is: *can a single person, applying the practices that scale a hundred-engineer system, build a game that ships and matures and serves players the way a real platform serves them?*

If the answer is yes, the game ships better than it would have, and I get to write the followup post. If the answer is no, I learn a lot about where the practices break down at solo scale, and I write a different followup post. Either one is valuable. That's why I'm spending evenings on it.

## The Conclusion

All to say — *why build a website?* I'm trying to do a lot of things with this one. As with all meaningful projects, it should have a lot of win cases. I want to keep working on Chronicles of Nesis. I love it. Now I can make it playable in the browser (or so I hope), focus more on the art, and have Claude do the code. I can ship an enterprise-grade website with cost optimization and real features — again, thanks to Claude — and write a devlog about how Claude enables others to do the same. And probably the biggest win, and the hardest to achieve: I can provide an example — ideally a runbook — for others to use Playwright with Godot and Claude to make great games.

It's f'n cool.

I really hope it works.
