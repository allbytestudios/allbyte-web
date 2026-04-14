---
title: "5x, then 1.1x, then 2.5x: Measuring Whether My AI Workflow Actually Saves Tokens"
description: "When Arc claimed the drain pattern was a 5x efficiency win, I believed it. Then the token split landed and the number became 1.1x. After a cache-read correction it settled at 2.5x. This is how a single honest measurement cycle changed our workflow — and why cache reads are the trap."
pubDate: 2026-04-14T14:00:00Z
category: "engineering"
devlog: "studio"
tags: ["claude", "efficiency", "tokens", "workflow", "ai-pair-programming"]
draft: true
---

Two weeks into working with my four-agent AI team ([Arc, Nix, Vera, Port](/devlog/arc-and-the-leads/)), Arc proposed a workflow change: **the drain pattern**.

The old way: for each ticket in the Ready queue, spawn a lead agent, give it the ticket, wait for the report, spawn the next agent. One ticket per spawn.

The drain pattern: give the lead its entire queue, have it work through all items in one spawn, return one summary. Six tickets handled per spawn instead of one.

Initial measurement: 5x improvement. Number of agent-spawns dropped by a factor of six. Arc was ready to call it a transformation.

I almost believed it. The actual story is more interesting.

## The first correction: messages aren't the signal

The 5x number was message-counts-per-spawn. Not cost. Not tokens. Not anything related to what my Claude plan actually bills for.

Anthropic's meter is input tokens + output tokens + cache-creation tokens. A single user turn in Claude Code often produces dozens of assistant messages — because every tool call (read a file, run a test, grep a path) becomes a new message in the session log. Each of those is a separate API roundtrip with its own token cost. The sizes of those roundtrips vary wildly: a short `Read` of a 50-line file is ~2k tokens round-trip; a deep investigation of a 5000-line subsystem is ~200k.

"6 tickets in 1 spawn vs 1 ticket in 1 spawn" meant fewer spawn-setup overheads. It didn't mean 6x less *work* per ticket. The per-ticket investigation still happened — the agent still had to read the same files, make the same tool calls, write the same output. Bundling them into one spawn saved the context-loading cost *once* for the batch, not six times. That's the real source of savings — but it's a token-level effect, not a message-count effect.

So Arc re-measured against total tokens. The number dropped to 1.1x.

That was almost a meaningless win. 1.1x barely beats noise. If the drain pattern had stayed at that number, the conclusion would have been "don't bother, the spawn overhead isn't meaningful." The workflow change would have been shelved.

## The second correction: cache reads are the trap

One more number emerged when I asked Arc to split his `tokens` field into the four categories Anthropic's API returns:

- `input_tokens` — billable
- `output_tokens` — billable
- `cache_creation_input_tokens` — billable (one-time)
- `cache_read_input_tokens` — **essentially free**

Claude's prompt caching is extraordinarily effective. Cache reads can be 10-20x larger than the fresh tokens in a single response — for a lead reading a big repo, you might see 50k output tokens built on top of 1.5M cache reads. Those 1.5M cost near zero.

When Arc measured "total tokens," cache reads dominated. Every cycle looked enormous. The gap between a single-ticket cycle (small context) and a batched cycle (reloading shared context) got washed out because both patterns had huge cache-read numbers attached.

Excluding cache reads — measuring only **fresh tokens** (input + output + cache_creation) — surfaced the actual signal. The drain pattern jumped from 1.1x to **2.5x** better than single-ticket spawning.

And three additional patterns emerged that were even better:

| Cycle pattern | Cycles | Fresh tokens/ticket | vs single |
|---------------|--------|---------------------|-----------|
| **Tech review (3 leads in parallel)** | 1 | **63K** | **4.0x better** |
| **Batched single_task (related tickets)** | 4 | 73K | 3.5x better |
| **Lead drain (queue-pull)** | 2 | 100K | 2.5x better |
| Single ticket per spawn | 12 | 256K | baseline |

Sample sizes are small — a single tech-review cycle isn't a measurement, it's an anecdote. But the shape is consistent across all three batched patterns, and the single-ticket baseline has twelve samples backing it up. Directionally clear.

## What actually drives the savings

The winning cycles all shared one property: **the tickets in the batch touched the same files, domain, or root cause.**

- `playtest-tech-review` — 3 leads reviewed 8 tickets in parallel. 63K fresh/ticket. The leads each loaded the playtest context once and evaluated all 8 tickets against it.
- `vera-q11-sl-test-run` — 5 tickets verified in one test pass. 50K fresh/ticket.
- `sl5-sl8-impl` — 2 bugs that both touched `saveGameSave()`. 60K fresh/ticket.
- `vera-sl-tests` — 4 save/load test files written together. 62K fresh/ticket.

The worst single cycle was `nix-q12-sl4`: one ticket, deep investigation, 575K fresh tokens. Order of magnitude worse than the best cycle. The work wasn't bad — that ticket genuinely needed that investigation — but it was the wrong shape for batching. It's the correct shape for single-ticket spawning.

The lesson: **batching wins come from shared context reuse, not from the act of batching itself.** Grouping tickets that touch the same files means the lead reads that code once. Grouping independent tickets into one spawn doesn't help; the lead still loads N different contexts.

## The Bundling phase

Based on this data, Arc added a new phase to the ticket lifecycle:

```
PLANNING → TECH REVIEW → BUNDLING → READY → IN PROGRESS → TESTING → DONE
                          ↑
                 Arc + Nix + Owner
```

**Bundling** sits between Tech Review and Ready. Three reviewers:

1. **Arc** proposes initial bundles by visible signals — same epic, related descriptions, named files in success criteria.
2. **Nix** reviews for **code-level coupling** — shared functions, hidden dependencies, cross-system effects Arc wouldn't see from outside the code.
3. **I** review for **design-level coupling** — narrative dependencies, feature ordering, priority clashes.

Final bundles move to Ready as groups. The lead picks up a bundle, not a single ticket.

Arc's rough estimate: a 5-minute Bundling discussion saves ~20M tokens on the resulting work. That's worth the overhead by two orders of magnitude. Skipping the phase is, as the saying goes, the opposite of efficient.

One honest caveat: **the Bundling phase has not yet been validated with real usage.** It was designed from data and added to the lifecycle immediately. The test will be whether fresh-tokens-per-ticket actually drops across the next month of cycles. If it doesn't, the phase needs tuning or dropping.

## Why the measurement was hard

Three things made this analysis take a week to get right:

**The tokens were split across two systems.** Arc runs inside a Docker container with its own `.claude/projects/` session logs. My host-side Claude has separate logs. Git commits come from both Arc's repo and mine (plus an older sibling repo). To compute any per-cycle ratio, all four streams had to merge into a single timeline keyed on hour buckets. That took a fair amount of plumbing.

**Prompt caching inflates every number.** Before the four-field split, every "total tokens" number included cache reads. Two cycles with 10x different real cost could show as nearly identical totals because both had millions of cache-read tokens attached. The split isn't optional — you cannot analyze efficiency without it.

**Sample sizes are tiny.** One session of data produced n=1 to n=12 samples per pattern. The 4x claim for tech-review parallel is built on a single cycle. Drain pattern is n=2. Even the strong baseline is only 12 samples. The shape is consistent but every number deserves a sample-size caveat.

## What I changed in my own workflow

Three observable changes since the analysis landed:

**1. The Bundling phase happens before Ready.** Tickets no longer go from Tech Review straight to the queue. Nix and I review Arc's proposed bundles, flag code-coupling and design-coupling issues, and the leads pick up bundles rather than individual tickets.

**2. My webapp dashboard de-emphasizes message counts.** The Dev Console historical chart now defaults to Output Tokens and Commits, with Messages demoted to a secondary series. Message counts are a poor cost proxy when batching is happening — they correlate weakly with fresh token cost. If the dashboard led with messages, it would show the wrong story.

**3. Arc publishes per-cycle efficiency metrics continuously.** Every agent cycle — spawn, task, drain, review — writes one line to `efficiency_metrics.ndjson` with the four-field token split, the tickets moved, the files written, and the agent IDs involved. This is how we'll measure the Bundling phase. Without per-cycle data, you can't tell if a workflow change is actually working.

## The meta-lesson

The drain pattern was three different numbers depending on how we measured it. Each correction came from someone saying "wait, that metric is lying to us." The 5x → 1.1x correction was mine (asking about tokens). The 1.1x → 2.5x correction was mine too (noticing cache reads were dominating). The follow-on patterns (Bundling, shared-context grouping) came from Arc's re-analysis after the correction.

None of that could have happened without data. Not narrative summaries; not "it feels faster"; not "the sessions are going well." Actual per-cycle token counts, by category, keyed to the tickets they produced.

For projects considering similar AI agent workflows, my advice is simple: **instrument from day one with the four-field token split.** A single "tokens" total hides the signal. Track `input`, `output`, `cache_creation`, and `cache_read` separately from the first session. When you find a pattern you think is working, measure the ratio of fresh tokens per unit of output (tickets, commits, PRs, whatever your atom is). Compare it to the non-pattern baseline. Be honest about sample sizes.

The 2.5x is a real number. My weekly token budget stretches considerably further than it did two weeks ago, for the same amount of shipped work. Whether the Bundling phase pushes it to 3.5x or 4x over the next month is what I'll be watching on the dashboard.
