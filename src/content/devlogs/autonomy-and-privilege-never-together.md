---
title: "How to Get the Best of Both Autonomy and Privilege"
description: "Running coding agents forces a bad choice: prompt for every action (safe but slow) or skip permissions entirely (fast but dangerous). I stopped choosing. Here's the privilege-separation design that lets a leashed, credentialed Claude on my host delegate to fully-autonomous, sandboxed Claudes in a container — why it dissolves the tradeoff, what actually keeps it secure, and where the honest holes are."
pubDate: 2026-07-18T16:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["agents", "security", "architecture", "claude", "privilege-separation", "ai-pair-programming"]
draft: true
---

If you run coding agents, you've hit this fork, probably without naming it. Either you leave the permission prompts on — the agent stops and asks before it touches anything — and you spend your day clicking *approve*, or you run it with `--dangerously-skip-permissions` and it rips through work unattended, and you spend your day hoping it doesn't `rm -rf` something real or get talked into it by a poisoned web page. Safe-but-slow, or fast-but-dangerous. One global switch, and neither setting is the one you actually want.

I stopped choosing, and the fix turned out to be a security principle older than I am, applied to a place people haven't applied it much yet. This post is that design — the honest version, holes included, because a security writeup that only sells is worthless.

## The one rule

Two properties are dangerous in a coding agent:

- **Autonomy** — it acts without asking.
- **Privilege** — it can touch real, valuable, irreversible things (prod credentials, `git push`, your AWS account).

Each is fine alone. Autonomy over a scratch directory with nothing real in it? Harmless — the worst case is it makes a mess you throw away. Privilege behind a human who approves each consequential action? Fine — a person is in the loop for anything that matters. **The catastrophe is combining them:** an agent that both acts without asking *and* can touch real things is one bad instruction — or one prompt injection — away from a very bad day, with no human between the mistake and the consequence.

So the rule is just: **never put both in the same process.** Give each agent exactly one.

## How it lands in my setup

I run a few Claude Code agents. They split cleanly along that line:

- **The host agent** holds the real keys — AWS, `git push`, production deploys. It is **fully privileged and fully leashed**: permission prompts stay *on*. It cannot do anything consequential without me seeing a prompt and approving it. Trusted, but supervised.
- **The container agents** run inside Docker with `--dangerously-skip-permissions`. They are **fully autonomous and fully caged**: no real credentials, no path to prod, blast radius confined to a disposable container and the project files mounted into it. Free, but they can't reach anything that would hurt.

A message bus connects them. The leashed-but-privileged host agent delegates work to the autonomous-but-sandboxed container agents, and their results come back over the same channel. Authority lives on one side of the wall; autonomy lives on the other; the bus is the only door between them.

## Why this dissolves the tradeoff instead of splitting the difference

The trap in the original fork is that it's *one setting for one process*, so any single agent must be either safe or fast. By **separating the two dangerous properties across two processes**, each agent gets to max out the property that's harmless for it:

- The sandboxed agents get *full* autonomy — no prompts, real velocity — because autonomy is harmless when there's nothing real to break.
- The privileged agent gets *full* gating — a human on every consequential act — because that's cheap when it's the *only* seat that needs it, instead of every action of every agent.

You're not compromising to a mediocre middle. You get real autonomy *and* real safety, at the same time, because they're happening in different places. That's the whole trick, and it's why it feels more powerful than a slider between "annoying" and "reckless."

There's an economics argument underneath this, too, and it's the part I find most convincing. Permission prompts only work if a human actually reads them — and a human drowning in prompts stops reading. (Anthropic has published telemetry on exactly this: approval rates near the ceiling and *falling diligence* over time; sandboxing cut prompts by most of their volume. Verify the current figures before quoting them, but the direction is not in dispute.) So gating *everything* isn't safe — it's *theater*, because fatigue guts it. This design gates only the host's *handful* of genuinely privileged actions — `git push`, an AWS deploy, a prod change — which are rare enough that a prompt still gets read. The container's thousand mundane edits, which would generate the fatigue, are never gated at all, because they can't hurt anything. You're not just trading autonomy for safety in different boxes; you're spending your scarce human attention only where it still works.

## The part the canon gets backwards

If you've read the academic version of this — the "planner/worker" or "thinking must never act" split — my setup will look inverted, and the inversion is the interesting bit. The canonical pattern makes the *reasoning* component low-privilege and untrusted, and a *separate high-privilege executor* only runs validated, normalized commands. It gates the **actor**.

I don't split thinking from acting. I split **two independent axes — autonomy and privilege — and refuse to let any one process hold both.** My autonomous agents aren't safe because something downstream validates their commands; they're safe because **they have nothing worth stealing.** Run them YOLO all day — there are no credentials in the box, no path to prod, nothing to exfiltrate. The privileged process, meanwhile, isn't a dumb executor — it's the *human-gated* one. Same underlying law ("never combine autonomy and privilege"), opposite assignment. Worth knowing the canon exists so you can say why you're doing it differently.

## What actually keeps it secure

Three load-bearing controls. The design is exactly as strong as the weakest of them:

1. **The sandbox is a real boundary.** The container physically cannot reach the host's credentials or prod. That's what makes container autonomy safe — an agent going completely off the rails in there can, at worst, corrupt files in a throwaway environment. If this boundary is soft, the whole model is soft.
2. **The privileged seat keeps its prompts.** Every action that touches something real routes through the host agent, which asks a human first. A person is always in the loop for the irreversible stuff. The instant you "temporarily" run that seat with skip-permissions for convenience, you've recombined autonomy and privilege in one process and thrown the design away.
3. **Cross-agent messages are treated as untrusted.** A message arriving over the bus is data, not a command from me. The receiving agent doesn't execute it as if the owner said it — it's explicitly lower-trust than a direct instruction, and consequential actions still hit the human gate.

Notice the shape: this is **the principle of least privilege plus privilege separation** — the same idea behind process sandboxing, `seccomp`, dropped capabilities, and the decades-old confused-deputy literature. I did not invent it. What's (still) underdocumented is applying it *this* way to a fleet of LLM coding agents.

## Where the honest holes are — mostly at the bus

A bus that lets instructions cross a trust boundary is exactly where the interesting attacks live — and it's the part almost nobody writes about, because the multi-agent-bus posts out there are all about *parallelism and throughput*, not about the bus being a **privilege boundary**. I'm not going to pretend the holes away:

- **Confused deputy.** The host agent is a deputy with real authority, and the bus lets other agents ask it to act. That's the textbook setup for tricking a privileged party into misusing its power on someone else's behalf. My mitigations — every handoff must carry the *owner's* original request as provenance, and consequential actions still prompt a human — are what stand between "delegation" and "exploitation." If provenance were forgeable or unchecked, this cracks.
- **Prompt-injection propagation.** The sandboxed agents ingest untrusted content — web pages, files, game data. A poisoned input could make one of them *emit a malicious bus message* aimed at the privileged seat. The host treating channel messages as untrusted, plus the human gate, is the backstop — but it means the classification of "which actions are safe enough to not prompt on" is genuinely load-bearing. A verb that looks safe but is harmful in context is the gap to watch.
- **A shared secret is a single point of failure.** My bus is gated by one shared secret all agents hold. Leak it and anyone can inject into any agent. Per-agent auth or signed messages would be stronger; symmetric shared-secret is the weak version, and I know it.
- **Docker is not a VM.** Container isolation is good enough for my threat model — a *misbehaving* agent, not a determined attacker sitting on a container-escape zero-day. If your threat model includes the latter, this boundary needs to be a real VM, not a container.

There's a tidy way to see *why* this holds up: the standard recipe for an agent catastrophe is Simon Willison's "lethal trifecta" — private data, untrusted content, and a way to exfiltrate, all in one context. This design breaks the trifecta *by construction*: the process with the private data (host credentials) never ingests untrusted web content, and the process that ingests untrusted content (the sandboxed agents) has no private data and no meaningful egress. The three ingredients are split across the wall, so they can't combine into the exploit.

The honest summary: the model is sound *in principle*, and its security rests entirely on three disciplines never slipping — the sandbox stays hard, the privileged seat stays prompted, and untrusted messages never get promoted to authority. Every hole above is some version of one of those three quietly relaxing.

## Why I think it's worth writing down

Not because it's novel security theory — it isn't; it's least-privilege and privilege separation wearing a new hat. Both halves are individually well-trodden: the "sandbox a single agent in Docker" story has been written a hundred times, and so has "run a swarm of agents over a message bus." What I haven't seen is the two fused with the security framing kept in front — the bus treated as the *privilege boundary*, the credential-holder kept human-gated, the autonomous tier kept powerless *on purpose*, and the whole thing threat-modeled honestly from a real, running solo rig instead of an enterprise IAM diagram. That's the gap this is trying to fill. The multi-agent-coding world is mostly running one of the two bad settings — prompts-on-everywhere (and burning out on approvals) or skip-permissions-everywhere (and quietly hoping) — and the third option is just privilege separation, if you're willing to hold three disciplines and be honest about the seams.

If you're building something similar and you've found a cleaner way to authenticate the bus, or you think my "untrusted channel message" backstop is thinner than I'm claiming — I'd genuinely like to hear it. That's the part I'm least sure of.
