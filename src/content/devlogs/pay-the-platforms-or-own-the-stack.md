---
title: "Pay the Platforms, or Own the Stack"
description: "Every indie dev has to choose what platforms to support for distribution, payments, hosting, and community. Each one costs time to integrate, and most take a cut of revenue. But with AI today, how much could a solo dev save owning more of this? Here's what I did."
pubDate: 2026-06-02T00:00:00Z
category: "strategy"
devlog: "studio"
tags: ["business", "self-hosting", "indie", "ai", "platforms"]
---

- AI makes shipping full games on web easier.
- Web games make building them via AI easier.
- Web games can reach most platforms from a single build.
- You pay for it by operating outside the defined ecosystem.

I've been chipping away at this. Build for the web, own the URL, build my own subscriber tier system, run my own infrastructure, ship updates without anyone's review process. I'm not a better engineer than the people building these platforms, but AI assistance shrinks the time cost of "build it yourself" enough that the math has shifted for one person sitting at a keyboard.

This isn't an argument for burning down the platforms. They're useful. They charge for value they deliver. The argument here is narrower: **for an AI-assisted solo dev, the math now favors self-hosting most of the stack.**

## The universe of cuts

Here's what the platforms actually charge, categorized so the conversation has a concrete shape.

**Distribution**

- Steam — 30% cut, plus you live inside their UI and recommendation system
- iOS App Store — 30% (15% under $1M), plus review process, plus they decide what's allowed
- Google Play — same shape as App Store
- Epic Games Store — 12%
- itch.io — 10% default; creator-friendly but still a cut
- Microsoft Store — 12-30%

**Patronage**

- Patreon — 8-12% + Stripe processing (11-15% total)
- Substack (paid) — 10% + Stripe
- Ko-fi (premium) — 0-5%
- Buy Me a Coffee — 5%
- Kickstarter — 5% + ~3% processing

**Email and newsletters**

- Mailchimp — $13-350/mo, tiered on list size
- ConvertKit / Kit — $15-300/mo
- Substack (newsletter side) — 10% if monetized
- Beehiiv — $0-99+/mo with revenue share above thresholds

**Community and forums**

- Discourse hosted — $100-500/mo
- Slack — free up to a limit, then per-seat
- Discord — free, but they own the community
- Circle, Mighty Networks — $40-200/mo

**Game backend and live ops**

- PlayFab — pay-as-you-go, can get expensive
- Unity Gaming Services — tiered
- GameAnalytics — free with tiers

**Analytics**

- Mixpanel, Amplitude, Heap — $0-2000/mo
- Plausible, Fathom — $9-90/mo

**Customer support**

- Intercom — $74+/seat/mo
- Zendesk — $25+/seat/mo
- HelpScout — $20+/seat/mo

Not all of these are equally bad. Discord is genuinely free and where most game communities actually live. Plausible at $9/mo is a fair price for hosted analytics. itch.io's cut funds a platform that's been a public good for indie devs for years. But for anything where the price is a percentage of revenue or a tier that scales with success, the math gets worse the more you grow.

## What two of these look like in practice

I've already replaced two of them in production.

**[Subscriptions instead of Patreon.](/devlog/patreon-vs-self-hosting/)** I built a tier system on Stripe Checkout + DynamoDB + Lambda + OAuth. Five tiers (free, Initiate, Hero, Legend, plus one-time donation amounts), JWT auth, Google and Discord login, the works. Runs for less than $5/month.

**[PWA install instead of the App Store.](/devlog/playable-on-your-phone/)** I just spent a few days turning The Chronicles of Nesis into something playable on a phone from a URL, installable to the home screen, with auto-update that only fires at the title screen so it never interrupts a mission.

Both run on infrastructure that costs less per month than a single Patreon supporter's subscription — for now. At some point cloud costs will become a concern, but I expect the tradeoff to still be worth it. I'll report on that as I find out.

The reason I could justify the engineering for either is the same: AI assistance.

## What AI actually changed

A few years ago, a solo developer could *theoretically* self-host all of this. The pieces have existed — Stripe has had Checkout, AWS has had Lambda, web standards have supported PWA install. The barrier wasn't possibility. It was time.

Building the Patreon replacement properly took roughly a week of evenings. Claude drafted the CloudFormation template, designed the DynamoDB schema, implemented the Lambda functions in Python, wired up OAuth flows for Google and Discord, generated the JWT auth logic, and handled the Stripe Checkout and webhook integration. I read every piece of code, fixed what didn't fit, and made the architectural decisions. But the engineering grind — the tedious "now I have to wire up OAuth state validation and HMAC-sign the callback parameter" — was hours instead of weeks.

The PWA pipeline took just a few days of similar shape. Replacing Mailchimp with a transactional-email opt-in flow took an afternoon. Setting up CloudFront with correct COOP/COEP headers took an hour. Each of these used to be a project. Now each of them is a session.

That's not just a 10x speedup, it's the difference between "I can't justify this against the game I'm trying to ship" and "I can do this on Saturday." Most platform fees price the engineering work you'd otherwise do yourself. When that work used to take weeks, the platform fee was a fair trade. When it takes hours, it isn't.

This is the actual news in 2026 — not that AI can write code, but that the math on building-vs-buying has shifted enough that solo devs can credibly own pieces of the stack that used to require a team.

## What you can't credibly replace

In a word, marketing. In a detailed list:

**Steam's discovery surface.** I can build my own URL. I can't build my own recommendation engine that surfaces my game to everyone else's audience. Steam has *made* games — its tag-and-recommend system has rank-changing power for indie titles that no marketing effort I could mount would match. Choosing not to use Steam is choosing to do my own outreach for every player. That's not free; it might not even be cheap.

**Payment processing rails.** Stripe (or an equivalent) is the floor. You can avoid Patreon's cut on top of Stripe's cut, but you can't avoid Stripe's cut itself unless you become a bank.

**Google search ranking.** I host my own site, but Google still gatekeeps how people find it. SEO is the inescapable middleman.

**Mobile push notifications.** PWA push exists but is limited and inconsistent — especially on iOS Safari. The App Store and Google Play own this lane.

**Console distribution — partially.** Xbox has Edge built in; Steam Deck runs full Linux with any browser you want. Both can host a PWA today, even if almost no players actually reach for the browser on them. Switch and PS5 don't expose user-facing browsers despite their hardware being perfectly capable of running one — that's a policy decision, not a technical limit, and the reason is straightforwardly that a browser would let games reach players outside the platform's storefront.

The honest version of the argument is: self-host the pieces you can, trade with the platforms for the pieces you can't, pay the cut where the cut earns its keep.

## What one build actually covers

There's a counter to the argument worth taking seriously: web isn't the only way to reach a lot of platforms. You could just ship native to everything. A native build pipeline that matches the reach of a single web build means Windows, Linux, and Mac for desktop; iOS and Android for mobile; and potentially Switch, PS5, and Xbox for console reach. Even ignoring consoles, each of those targets is its own build configuration, code signing, store presence, update process, and support burden.

I spent weeks trying to get The Chronicles of Nesis to run correctly on Linux. I gave up on making it work on Mac. Browser deploy has its own annoyances — quirks, edge cases, the iOS PWA polish I still haven't done — but that's all. It's one deploy.

A single web build reaches Windows, Linux, Mac, iOS, Android, Steam Deck, and Xbox out of one artifact. It doesn't reach Switch or PS5 — a real gap if those are your target platforms — and it doesn't reach the nostalgia-coded path of physical cartridges or original hardware at all, which is a serious cost for the segment of devs whose whole identity is "my game ships on the SNES." Those are real tradeoffs, not catches.

So is it worth it? Every situation is different, but I'd argue you have some serious benefits to deploying on web.

First, the hurdle to export to web fits AI's strengths — complex WASM dependency and timing, but verbosely documented. Second, exporting the game to web better supports AI testing and automated QA, where Playwright has been extensively invested in by the industry. Third, you reach maximum platforms on a single build. You can always expand to PS5 and Switch after growing or success.

## Where I am

I'm not running a platform. I'm not selling a tool. I'm one solo dev shipping one game, who chose the self-hosted path piece by piece and is finding it works.

The argument I'm making is small: **if you're an AI-assisted solo dev, walk through your stack and ask which pieces are still worth the cut.** A lot of them aren't anymore, and that's new information. If the answer changes for some pieces and stays the same for others, that's the right answer. The point isn't to burn down the platforms; the point is to notice that the deal you've been making with them was priced for an engineering economy that no longer exists.

What's next, for me, is finding out whether this is also a thing other Godot devs would want to do — and whether the tools I built for Chronicles of Nesis could be wrapped in a way that lets other indies make the same choice without doing the engineering twice. There's a different post in that direction, eventually.
