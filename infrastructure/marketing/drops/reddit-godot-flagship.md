# r/godot flagship post — "real tactical RPG, in your browser" (contrast play)

**Strategy:** depth-first, web-as-the-twist. The published devlog *Painting Around the
Grid* is the proof (4 real-game aspects in one video-rich piece); this post leads with
that depth, lands the browser kicker, and links play + the devlog. The WASM/porting
devlog is the *follow-up finale*, not the lead (here it's just a comment link for the
curious). See [[project_marketing_positioning]].

**Why this works for r/godot:** showcase/technique, not "play my game." Godot devs know
the baseline is jam demos — a full hand-painted tactical RPG running in a browser tab
defies it, and they can click and play instantly (zero friction).

---

## Title (pick one — lead with depth, land the browser twist)

1. **(primary)** `Hand-painted tactical RPG in Godot 4 — pre-rendered backgrounds, a town to explore, seamless combat transitions — and it runs in your browser, no download`
2. `I got a full hand-painted tactical RPG running in the browser (Godot 4) — pre-rendered world, tactical grid combat, no download`
3. `Chasing golden-era JRPG depth in Godot 4: pre-rendered backgrounds + tactical combat, playable in your browser`

## Native video
Upload **combat-transition.mp4** natively to Reddit (Reddit favors native video).
- S3: https://allbyte.studio/captures/recordings/combat-transition.mp4
- (alt: town tour — https://allbyte.studio/captures/recordings/town-tour-laria.mp4)
The combat transition is the strongest single "real game" hook: painted scene → grid → battle.

## Body
```
I've been building a tactical RPG in Godot 4 with one goal: the depth and feel of a
golden-era JRPG — a hand-painted world you actually explore that flows straight into
tactical grid combat — running entirely in a browser tab. No download, no plugin.

A few pieces, since this sub appreciates the how:

- Pre-rendered, hand-painted backgrounds + a fixed camera. A near-dead technique
  (FF7 / early Resident Evil era), but for a tactical game the fixed frame is the
  feature: I compose the dramatic angle AND the tactical grid that has to sit on it at
  the same time, so drama and readability get authored together instead of traded off.

- A depth-of-field movement mechanic that fakes 3D on the flat painting — as you move
  into a scene you scale down, slow down, and drift toward a vanishing point, so a
  static backdrop reads as a space you move *into*.

- A seamless transition into combat — the world flows into a tactical grid battle
  without a hard scene-change gear-grind.

And the whole thing ships as a Godot 4 web export — which, if you've shipped to HTML5,
you know is its own gauntlet (SharedArrayBuffer headers, single-thread hangs, the works).

Happy to get into any of it — the pre-rendered/grid co-authoring, the depth-of-field
logic, or the web-export gotchas.
```

## First comment (links — Reddit norm: links in a comment, not the post body)
```
Play it free in the browser (no download): https://allbyte.studio/play/
The craft writeup, with videos: https://allbyte.studio/devlog/painting-around-the-grid/
And the web-export gauntlet, if you want the gory bits: https://allbyte.studio/devlog/wasm-gotchas-and-web-export/
```

## Posting notes
- **Account warmth gate:** only post if the Reddit account has some karma + prior
  participation in r/godot / r/gamedev. If it's cold, comment/contribute first, then post.
- **Framing is showcase/technique, not player-acquisition.** No "wishlist"/"play my game"
  hard-sell. Lead with the craft; the browser twist is the surprise.
- Stay and reply to comments in the first 30-60 min.
- Secondary subs (reword the title, don't cross-post identically): r/IndieDev, r/IndieGaming, r/tacticalrpg.
