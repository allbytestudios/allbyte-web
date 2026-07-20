---
title: "A Save-State Tree in an Afternoon: Three Agents, One Pipeline, Every Complication Catalogued"
description: "My QA lead designed a branching tree of loadable save states, my orchestrator promoted them into the game repo, and my web agent shipped the click-to-jump UI — same day, over the message bus. Here's the full catalogue of what made a 'simple' feature genuinely hard: pack-mount ordering, dev/prod layout drift, silent message loss, and the honest bottleneck nobody expected."
pubDate: 2026-07-16T18:00:00Z
category: "workflow"
devlog: "godot-and-claude"
audience: "ai-dev"
tags: ["agents", "qa", "testing", "workflow", "claude", "godot", "save-states"]
draft: true
---

Yesterday I wrote about [the message bus](/devlog/a-message-bus-for-my-agents/) that lets my three Claude seats talk in real time. That post ends on an honest hedge: one good afternoon isn't a throughput study. This post is the next data point — a complete feature, designed → built → deployed → verified in a single day, across all three seats. And more usefully, it's a **catalogue of every complication** that a "simple" QA tool actually contained, because the gap between the one-paragraph idea and the shipped thing is where all the engineering lives.

## The idea, in one paragraph

The Chronicles of Nesis is a tactical RPG, which means balance testing has a geometry problem: the interesting states are *deep* in the game. To test a boss fight against a pauper build, someone has to play there — every time, for every variant. The fix is a **save-state tree**: a branching graph of real, loadable saves, one tree per difficulty. The root is the first save after New Game; each edge is a major player decision (grab the chest, buy the relic, learn the skill); each node is a save you can jump into. Browse the tree in the web console, click a node, and the running game loads that exact state. QA, balance work, and boss experimentation stop paying the walk-there tax.

One paragraph. Here's what it took.

## Who owned what

The design splits along the same seat boundaries the team already has, and the boundaries did real work:

- **Quinn** (QA seat, in the container) designs the tree and *plays every node into existence* — user-equivalently, through the real Save menu, so each save is something a player could genuinely have. She verifies each node is chain-legal: no impossible stats, no sequence a real playthrough couldn't produce.
- **Arc** (orchestrator, in the container) owns the **promotion boundary**: he copies Quinn's staged blobs into the game repo's fixture library, merges rows into the manifest, and commits. Nothing Quinn stages is real until Arc lands it.
- **App** (web seat, on the host — the one writing this) consumes the manifest, mirrors the save blobs to the website's own origin, renders the tree, and wires the jump.

Nobody writes into anyone else's territory. Quinn *produces*, Arc *commits*, App *ships*. When something went wrong — and several somethings did — that boundary is what made each failure findable, because every artifact had exactly one owner.

## Playing a node into existence

The part I couldn't see from my seat, reconstructed from Quinn's notes afterward. A node is only legitimate if it's **played, not authored** — user-equivalent input the whole way: click-navigation along the same paths a real left-click takes, dialogue advanced line by line, and the save written through the *actual pause menu*, not a debug export. The blob is then extracted read-only from the browser's localStorage — the in-game save slot is just a scratch buffer; the extracted file is the durable node.

And the round almost didn't start: the driving harness **couldn't open the pause menu at all**. Its input enum lacked the `ui_select` action and the game's test bridge had no generic way to inject one — so the QA seat literally could not press the one button that opens the save UI. The fix spanned three layers (a bridge hook in the game, the executor's press table, the driver's enum), landed and redeployed before the first node was captured. The feature's very first dependency was a capability gap nobody had listed.

The driving itself produced its own gotcha catalogue: extract the save while the pause menu is still open and the player stays input-locked, so the *next* navigation fails for a non-obvious reason (fix: always close the menu first). Long routes exceed the click-navigation budget and need intermediate sub-goals — never a scripted scene-warp, which would break the played-not-authored rule. "Arrived at the door" and "the scene actually changed" are different events. Each one of those is exactly the kind of thing a chain-legal save *must* survive, which is why she plays them instead of forging them: the hand-authored boss fixture from an earlier round had HP over the derived max and skills without the tree investment to justify them. Played nodes can't contain that class of bug, by construction.

## The catalogue

This is the part I actually want on record: everything that made this harder than the paragraph. Not because any single item is exotic, but because this density of complication inside a one-day feature is what real integration work looks like — and it's exactly the terrain where multiple narrow agents beat one broad one.

### 1. The game must never fetch a save by ID

The hardened web build deliberately has no "load fixture by name" hook — that would be a door anyone could knock on. So the flow is inverted: the web page fetches the save JSON **same-origin from its own mirror**, then hands the raw bytes to the game inline through a test-bridge property. The game never sees a URL, only data. That's why App maintains a mirror at all: a save that only exists in the game repo is invisible to the launcher by design, not by accident.

### 2. Load ordering is a contract, not a suggestion

A save that references a scene from an unmounted content pack doesn't fail loudly — it warps into a **null scene**. So the jump sequence is strict: mount the packs → *wait until their scene classes actually register* (not just until the fetch finishes) → import the save → trigger the real load path the Continue button uses → hold the loading overlay until the target scene has replaced the title screen. Every arrow in that chain earned its place from some earlier bug.

### 3. "The root won't need packs" — wrong

I assumed the tree's root node (the hero's own house, seconds into the game) lived in the base build. Quinn corrected me within the hour: the house — and every village and dungeon scene — lives in the Laria content pack. **Every node in the tree needs `packs: ["Laria"]`, root included.** Without her correction, the very first jump anyone tried would have hit the null-scene warp from item 2. The schema gained a `packs` field per node before a single row shipped.

### 4. Identifiers lie unless someone checks

The pack's mount ID is `Laria`. There is also a file named `LariaVillage.pck` in the export directory. Arc didn't take the name on faith — he traced the scene map and the pack loader's actual fetch path to confirm which string the engine wants. Thirty seconds of verification against a bug that would have produced *silently empty* pack mounts.

### 5. Freeze the schema before the content scales

Quinn's design called for ~30 nodes growing to 80. Her explicit ask, before any rows existed: does the web side want schema changes? *Cheaper to fix now than after 30 rows.* Two fields came out of that review (`packs` from item 3, plus display `tags`), and one field was **rejected** — no thumbnail column, because the save blobs already embed one. Schema review before content scale-out is old-fashioned data-team discipline, and it applies unchanged when the producer, committer, and consumer are three AI agents.

### 6. Dev and prod disagreed about where packs live

The first live jump test loaded the save, mounted nothing, and stalled at the title screen. Root cause: the game repo's local export keeps **one shared `packs/` directory** for all build channels, but the deployed CDN gives **each channel its own** `packs/` subdirectory. The web console's dev proxy faithfully served the local layout — so a pack URL that works in production 404'd on my desk. The fix is a dev-only fallback rewrite, and the lesson is the old one: the test that saved us was the one that drove the *real* flow end-to-end instead of trusting that each half worked.

### 7. The transport ate two messages — silently

Two delivery failures in one afternoon, both silent. First: sending a message into the container without wiring stdin through (`docker exec` minus the `-i` flag) delivers an **empty body** — the receiving agent got a blank ping and politely asked what I wanted. Second: the bus has no broadcast, so when Quinn addressed a handoff to Arc but posted it only to my bridge, Arc simply never got it. I checked his inbox, saw nothing from her, and forwarded it with a note. Both are the same genus as [the reply that never arrived](/devlog/a-message-bus-for-my-agents/): in any messaging system, *"sent" and "received" drift apart unless something actively reconciles them.* The fix for the afternoon was cheap — verify the receiving end, don't trust the sending end's optimism.

### 8. Agents fact-check each other, and it matters

When Arc went to apply Quinn's manifest correction, he found her "handed-off manifest" **didn't exist on disk** — her earlier handoff had been prose-shaped JSON inside a coordination note, not a real file. He applied the one-field fix himself, flagged the discrepancy, and Quinn re-staged it as an actual file. No seat took another seat's claim as ground truth, and the pipeline was right *because* of that. This is the provenance discipline from the bus post paying rent in ordinary work.

### 9. Headless testing has its own traps

The automated jump test initially reported an empty game state — not because the game failed, but because the play page's **download gate** (the ~75 MB "are you sure" screen) withholds the game iframe entirely until acknowledged. The test had to click consent like a human would. Every gate you add for users is a gate your automation must also pass; the test suite is a user.

### 10. Game economy is schema too

Mid-afternoon I corrected Quinn's economy read: the room chest at the start gives 100 sen. That single fact reshaped the tree's *semantics* — a zero-sen node now provably means "chest skipped," which is what makes the pauper branch a real pauper branch, distinct from the maximal branch that spends that money. The manifest didn't change; what a row **means** did. Data models encode world knowledge, and the world here is the game's economy.

## The tooling found real bugs before it existed

The strongest argument for the tree isn't hypothetical — the *capture process itself* surfaced two real bugs on day one.

**QB-019: a fresh Hard game starts at 11/41 HP.** While capturing the very first node, the pause menu showed the hero at ~27% health on a brand-new game — zero battles, zero steps. The extracted blob confirmed it: a base `currentHealth` seeded before the max is ever derived from stats, so every new player starts hurt. Same root-cause family as two earlier bugs, and it only surfaced because the node-capture loop *reads real persisted state* instead of trusting the screen.

**A shop dual-cursor desync.** The shop's grey highlight bar and the actual selection cursor (the one that drives the description panel and what confirm *buys*) can point at different rows. Quinn tracked the bar and bought the wrong item — recovered via the shop's reset button, re-drove by watching the description panel instead. A keyboard player could make the same mis-buy. That's a genuine UX bug found not by a test *for* the shop, but by an agent trying to spend 100 sen the way a player would.

That's the pitch for QA tooling in one afternoon: build the machine that visits real states, and it finds the bugs living in them for free.

## What the mesh actually bought

Count the hand-offs in that catalogue: Quinn→App (pack correction, schema answers), App→Arc (path convention, packs discrepancy), Arc→App (commit notifications), App→Quinn (relaying Arc's missing-file flag), plus the live end-to-end test Quinn requested and I ran. Ten-plus round trips, each one a potential half-day stall in the old leave-a-markdown-file era. Over the bus, the whole feature — a capability gap closed in the driving harness, schema negotiation, four game-repo commits, four web deploys, one dev-proxy bug found and fixed, five chain-legal nodes captured, two real game bugs filed, and a verified in-game jump landing in the hero's house with the right pack mounted — fit inside an afternoon, with verification at every leg.

The multi-agent structure wasn't overhead here; it was the *safety system*. Every complication in the catalogue was caught by a seat doing its narrow job well: Quinn knew the pack layout, Arc verified the mount ID, App drove the real browser flow. One generalist context could have made every one of those mistakes in a row and compounded them.

## The honest bottleneck

Here's the finding I didn't expect to write down. The slowest link in the mesh, measured over the whole afternoon, wasn't an agent. **It was me** — specifically, the web seat runs on the host with permission prompts on (it holds the deploy credentials, so it asks before it acts), and every prompt waits for my attention. The container seats, sandboxed away from anything dangerous, answered each other at the speed of the fix. The credentialed seat ran at the speed of *my glance*.

That's not a complaint about the safety model — the prompts exist because that seat can touch production, and I want a human between an agent and my AWS bill. But it reframes the optimization question. The next speedup isn't a smarter agent or a faster bus; it's narrowing what the prompted seat needs prompts *for* — pre-approving the safe verbs so attention is spent only on the dangerous ones. The team is no longer waiting on the code. It's waiting on the org chart.

As always, the boundary I hold: none of this touches the art. The sprites in those save thumbnails, the music that plays when a jump lands — handcrafted, every one. The agents build the machinery that lets me spend more time on exactly that.
