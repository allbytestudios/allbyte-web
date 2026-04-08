---
title: "Why Build Our Own Site Instead of Using Patreon?"
description: "An honest look at what we're giving up by self-hosting instead of using Patreon — and why we're trying it anyway."
pubDate: 2026-04-08
category: "technical"
tags: ["business", "patreon", "self-hosting", "stripe", "indie"]
---

This isn't a conclusion. It's a hypothesis. We're betting that self-hosting our own subscription platform is worth the tradeoff over Patreon — but we could be wrong, and it's important to lay that out honestly.

## What Patreon Gives You for Free

Patreon is a known brand. When someone sees "Support me on Patreon," there's instant recognition. They know what it is, they trust it with their credit card, and they probably already have an account. That's a massive advantage that's easy to underestimate.

Beyond trust, Patreon provides:

- **Discoverability** — Patreon surfaces creators to potential supporters. People browse the platform looking for things to back. Your page exists inside a marketplace.
- **Payment infrastructure** — Stripe integration, failed payment recovery, currency handling, invoicing — all handled. You never touch a webhook.
- **Mobile app** — Supporters get push notifications, manage their subscriptions, browse exclusive content from their phone.
- **Community tools** — Posts, polls, DMs, tiers with gated content, Discord role integration. All built in.
- **Legal and tax compliance** — VAT collection, sales tax handling, 1099 generation for US creators. This is genuinely complicated to do yourself.

That's a lot of value. And for a solo indie dev trying to build a game, every one of those is a feature you'd either need to build or go without.

## What Patreon Costs

Patreon's Pro plan takes **8% of every dollar** your supporters pay. The Founders plan from the early days was 5%, but new creators pay 8-12% depending on the plan. On top of that, there's payment processing (Stripe's 2.9% + 30¢) which Patreon passes through.

So on a $7/month subscription, Patreon keeps roughly **$0.56 in platform fees** plus **~$0.50 in payment processing**. That's $1.06 out of every $7 — about 15%.

But the cost isn't just money:

- **You don't own the relationship.** Patreon owns your subscriber list. If you leave, you can't take your supporters with you easily. You're building on rented land.
- **Platform risk.** Patreon changes their terms, algorithms, and fee structures. They've done it before. Creators have been demonetized or had their accounts flagged. Your income depends on a company's policy decisions.
- **Limited customization.** Your page looks like every other Patreon page. You're a row in someone else's database, not a destination.

## What Self-Hosting Gives You

Our setup costs roughly **under $5/month** for hosting (S3 + CloudFront + Route 53 + Lambda + Secrets Manager) plus **Stripe's 2.9% + 30¢ per transaction**. No platform fee on top.

On that same $7/month subscription, we'd pay about **$0.50 in Stripe fees**. That's it. The difference is $0.56/subscriber/month — small at first, but it scales linearly.

More importantly:

- **Full ownership.** We own the subscriber data, the email list, the payment relationships. If we ever move platforms, we take everything with us.
- **Creative control.** The site matches our brand exactly — the bilateral layout, the custom font, the engine/heart aesthetic. It's not a Patreon template.
- **No platform dependency.** Nobody can change the rules on us. The site is static files on a CDN we control.

## What Self-Hosting Actually Costs (The Honest Part)

Here's where we need to be critical of our own decision.

### Marketing Risk

Nobody is going to stumble onto allbyte.studio. There's no Patreon browse page, no recommendation algorithm, no "creators you might like" sidebar. Every single subscriber has to be driven there through our own marketing — social media, Discord, word of mouth, gameplay clips. Patreon has a built-in audience. We have a domain name.

This is probably the biggest risk. A beautifully engineered site with zero traffic is worse than an ugly Patreon with 50 subscribers.

### Trust Risk

"Support me on Patreon" is a sentence people understand. "Go to allbyte.studio and click Subscribe" is a harder sell. People trust known brands with their credit card numbers. A custom domain with a custom payment flow looks sketchy to anyone who's been on the internet long enough. We use Stripe Checkout (which people do recognize), but the path to get there is unfamiliar.

### Technical Risk

Every bug is our bug. OAuth breaks at 2am? That's on us. Stripe webhook misses an event? We're digging through Lambda logs instead of making the game. CloudFront serves a stale page? Us again.

Patreon has an engineering team. We have Claude and a prayer.

### Opportunity Cost

Every hour spent on infrastructure — building OAuth, debugging CloudFormation, writing this very analysis — is an hour not spent on the game. The whole point of AllByte Studios is to make a tactical RPG. Not a web platform.

This is the trap: the infrastructure work is *interesting*, and it feels productive, but it's not the thing that matters. If the game isn't good, the website is irrelevant.

### Unknown Unknowns

What happens when we need:
- Refund handling?
- Subscription pausing?
- Gift subscriptions?
- Annual billing?
- Tax compliance across jurisdictions?
- Failed payment retry logic?

Patreon has solved all of these. We'd need to build each one or accept that we don't have it. Every missing feature is a reason someone doesn't subscribe.

## The Hypothesis

We're betting that the combination of:

1. **Low hosting costs** (<$5/mo vs 8-12% of revenue)
2. **Full data ownership** (subscriber list, payment history)
3. **AI-assisted development** (Claude turns weeks of infrastructure work into hours)

...will outweigh the marketing, trust, and maintenance overhead.

The third point is the key one. Five years ago, a solo developer self-hosting a subscription platform would be absurd — the engineering cost alone would consume all your time. But with an AI pair-programmer that can write CloudFormation templates, debug OAuth flows, and set up CI/CD pipelines in a single conversation, the calculus changes.

The infrastructure that used to be the hard part is now the fast part. The marketing and trust-building — which Patreon solves — is now the hard part.

**This is unproven.** We could end up with a beautifully engineered ghost town and wish we'd just set up a Patreon page in 10 minutes. That's a real possibility, and we're going in with eyes open.

But we want to try it. Worst case, we learn a lot and migrate to Patreon later with all the technical knowledge intact. Best case, we keep 100% of our revenue minus Stripe's cut and own everything.

We'll report back.
