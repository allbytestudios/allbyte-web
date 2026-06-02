---
title: "Pay the Platforms, or Own the Stack"
description: "Every indie dev makes the same choice: pay the platform middlemen for distribution, payments, hosting, and community, or do it all yourself. AI made the second path realistic for one person. Here's the math."
pubDate: 2026-06-02T00:00:00Z
category: "strategy"
devlog: "studio"
tags: ["business", "self-hosting", "indie", "ai", "platforms"]
draft: true
---

Every indie dev makes the same set of decisions when shipping a game. Where does it sell — Steam, App Store, Google Play, itch? Where do supporters back you — Patreon, Substack, Ko-fi? Where do you host your newsletter, your forum, your analytics, your support inbox? For most of indie dev's history, the answer was the same: use the platforms. They take a cut, but they handle the parts you can't.

I've been chipping away at the other answer. Build for the web, own the URL, build my own subscriber tier system, run my own infrastructure, ship updates without anyone's review process. So far it's working. Not because I'm a better engineer than the people building these platforms — because AI assistance shrinks the time cost of "build it yourself" enough that the math has shifted for one person sitting at a keyboard.

This isn't an argument for burning down the platforms. They're useful. They charge for value they deliver. The argument here is narrower: **for an AI-assisted solo dev, the math now favors self-hosting more pieces of the stack than was previously realistic.** Not all of them. But more.

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

I've already replaced two of them in production. Both have their own writeups; here's the shape.

**Subscriptions instead of Patreon.** I built a tier system on Stripe Checkout + DynamoDB + Lambda + OAuth. Five tiers (free, Initiate, Hero, Legend, plus one-time donation amounts), JWT auth, Google and Discord login, the works. Runs for less than $5/month. The full story is in [Why Build My Own Site Instead of Using Patreon?](/devlog/studio/patreon-vs-self-hosting/) — the short version is that the math works at any scale, the real risk is marketing and trust, and I haven't lost that bet yet.

**PWA install instead of the App Store.** I just spent a week turning The Chronicles of Nesis into something playable on a phone from a URL, installable to the home screen, with auto-update that only fires at the title screen so it never interrupts a mission. Full writeup in [Playable on Your Phone, Without an App](/devlog/studio/playable-on-your-phone/). No app store cut, no review process, no platform deciding whether my updates are allowed to ship.

Both run on infrastructure that costs less per month than a single Patreon supporter's subscription. The reason I could justify the engineering for either is the same: AI assistance.

## What AI actually changed

A few years ago, a solo developer could *theoretically* self-host all of this. The pieces have existed — Stripe has had Checkout, AWS has had Lambda, web standards have supported PWA install. The barrier wasn't possibility. It was time.

Building the Patreon replacement properly took roughly a week of evenings. Claude drafted the CloudFormation template, designed the DynamoDB schema, implemented the Lambda functions in Python, wired up OAuth flows for Google and Discord, generated the JWT auth logic, and handled the Stripe Checkout and webhook integration. I read every piece of code, fixed what didn't fit, and made the architectural decisions. But the engineering grind — the tedious "now I have to wire up OAuth state validation and HMAC-sign the callback parameter" — was hours instead of weeks.

The PWA pipeline took another week of similar shape. Replacing Mailchimp with a transactional-email opt-in flow took an afternoon. Setting up CloudFront with correct COOP/COEP headers took an hour. Each of these used to be a project. Now each of them is a session.

That's not a 10x speedup. It's the difference between "I can't justify this against the game I'm trying to ship" and "I can do this on Saturday." Most platform fees price the engineering work you'd otherwise do yourself. When that work used to take weeks, the platform fee was a fair trade. When it takes hours, it isn't.

This is the actual news in 2026 — not that AI can write code, but that the math on building-vs-buying has shifted enough that solo devs can credibly own pieces of the stack that used to require a team.

## What you can't credibly replace

The argument loses credibility if it overstates. Here's what self-hosting doesn't fix.

**Steam's discovery surface.** I can build my own URL. I can't build my own recommendation engine that surfaces my game to everyone else's audience. Steam has *made* games — its tag-and-recommend system has rank-changing power for indie titles that no marketing effort I could mount would match. Choosing not to use Steam is choosing to do my own outreach for every player. That's not free; it might not even be cheap.

**Payment processing rails.** Stripe (or an equivalent) is the floor. You can avoid Patreon's cut on top of Stripe's cut, but you can't avoid Stripe's cut itself unless you become a bank.

**Google search ranking.** I host my own site, but Google still gatekeeps how people find it. SEO is the inescapable middleman.

**Mobile push notifications.** PWA push exists but is limited and inconsistent — especially on iOS Safari. The App Store and Google Play own this lane.

**Console distribution.** Switch, PlayStation, Xbox — not realistically replaceable for the foreseeable future. If your game needs to ship to consoles, you're paying their tax.

The honest version of the argument is: self-host the pieces you can, trade with the platforms for the pieces you can't, pay the cut where the cut earns its keep.

## The cost comparison

The numbers depend on scale, but the shape is the same at any size.

At my current scale — small audience, growing — I pay:

- ~$5/month for AWS (S3, CloudFront, Lambda, DynamoDB, Route 53, Secrets Manager)
- Stripe's 2.9% + 30¢ per transaction
- ~$15/year for the domain
- $0 for analytics (rolling my own from CloudFront logs)
- $0 for transactional email (SES; pennies even at scale)
- $0 for community (Discord)

If I'd put the equivalent setup on the platforms, the monthly cost would include Patreon's 8-12% cut on every subscription, Mailchimp at $20+/month for my list size, hosted analytics at $9-90, hosted community at $40-500 for Circle or Mighty or hosted Discourse, App Store / Google Play 30% on any mobile revenue, and Substack's 10% if I monetized newsletters.

The fixed costs alone are 5-10x what I currently pay. The percentage cuts compound on top of that the more the project grows. Even at low scale the math is striking, because platform minimums are flat tiers and mine are pennies. At higher scale — if Chronicles takes off — the math becomes lopsided.

Either direction makes the argument.

## Who this is actually for

This case lands hardest with three audiences.

**Solo devs pre-revenue.** The 30% cut isn't bleeding you yet, but the workflow pain of app store review processes absolutely is. The pitch resonates as "ship faster, no waiting for review, no rejected-for-cosmetic-reason rounds."

**Mid-tier indies with revenue.** 30% is real money. The pitch resonates as economics.

**Platform refugees.** Unity runtime fee survivors, App Store rejection victims, Steam discoverability frustrated. Already convinced of the problem. The pitch sells you the alternative you already wanted.

It lands softest with mobile-first studios where App Store distribution is your oxygen, and with anyone whose game lives or dies by Steam's discovery surface. Those aren't bad choices — they're a different optimization. The math that flips for a solo AI-assisted dev with a small audience doesn't flip the same way for a studio with a marketing team and a discovery problem.

## Where I am

I'm not running a platform. I'm not selling a tool. I'm one solo dev shipping one game, who chose the self-hosted path piece by piece and is finding it works.

The argument I'm making is small: **if you're an AI-assisted solo dev, walk through your stack and ask which pieces are still worth the cut.** A lot of them aren't anymore, and that's new information. If the answer changes for some pieces and stays the same for others, that's the right answer. The point isn't to burn down the platforms; the point is to notice that the deal you've been making with them was priced for an engineering economy that no longer exists.

What's next, for me, is finding out whether this is also a thing other Godot devs would want to do — and whether the tools I built for Chronicles could be wrapped in a way that lets other indies make the same choice without doing the engineering twice. There's a different post in that direction, eventually.

For now: the report-back from the patreon devlog two months ago is that it's working. The PWA install pipeline is working. The cost is real, but it's lower than the cuts I'd be paying. And the engineering, which used to be the prohibitive part, is no longer prohibitive.

That's the actual news.
