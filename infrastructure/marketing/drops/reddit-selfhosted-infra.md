# Drop — r/selfhosted (SEPARATE TRACK, around the WASM era)

**This is NOT a game post.** r/selfhosted removes "look at my game" content as
off-topic. It's strict about being about services/infra you self-host. But you have a
genuine self-hosting story it will engage with: running an entire indie studio's stack
yourself instead of renting platform SaaS. Frame it as an infra/cost story; the game is
just the workload that happens to run on it.

**Different funnel, different CTA:** the play link is NOT the headline here. The
contextual link is the own-the-stack writeup. Don't lead with "play my game."

**Contextual link = the own-the-stack devlog** (+ the long-form self-hosting writeup):
- https://allbyte.studio/devlog/pay-the-platforms-or-own-the-stack/
- https://allbyte.studio/self-hosting-with-claude/

## Title (pick one — infra/cost framing, no game promo)
1. **(primary)** `I run my whole indie-studio stack self-hosted instead of paying platform SaaS — site, marketing automation, observability — here's the setup and what it costs`
2. `Self-hosting an entire solo software shop: own-the-stack instead of per-seat SaaS, with cost guardrails so a runaway bill can't happen`
3. `Replaced the SaaS sprawl for my side project with a self-hosted stack (Postiz, own observability, S3/CloudFront) — write-up + costs`

## Body
```
I run a small software project on the side and went out of my way to self-host the
supporting stack instead of stacking up SaaS subscriptions. What's self-hosted:

- Marketing/social scheduling on self-hosted Postiz (Postgres + Redis) instead of a
  paid social tool.
- My own observability stack rather than a hosted APM seat.
- Static site on S3 + CloudFront I own, with hard budget guardrails — a cap + auto-shutoff
  so a misconfig or traffic spike can't run up a surprise bill.

The thesis I keep coming back to: past a point, "pay the platforms" quietly becomes the
biggest line item and the biggest lock-in, and self-hosting the same capabilities is both
cheaper and more durable. Full write-up with the architecture and the actual costs below.
Curious how others draw the self-host-vs-SaaS line for a one-person operation.
```

## First comment (links)
```
Write-up — pay the platforms or own the stack: https://allbyte.studio/devlog/pay-the-platforms-or-own-the-stack/
Longer architecture + cost breakdown: https://allbyte.studio/self-hosting-with-claude/
```

## Posting notes
- **Keep the game out of the framing.** If asked what the workload is, mention it
  plainly in a reply — but the post is about the stack, not the game. Leading with the
  game = removal.
- No video. This is a text/architecture post.
- Optional sibling subs (same infra angle, reword): r/homelab (if there's a hardware
  story), r/devops (CI/CD + guardrails angle).
