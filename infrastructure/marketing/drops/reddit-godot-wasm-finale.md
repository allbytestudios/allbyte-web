# Drop — r/godot WASM finale (LADDER DAY ~9, the technical payoff)

**Role:** the crown-jewel finale, posted ~1 week after the flagship so it's a distinct
moment, not a repeat. The flagship sells the *game*; this sells the *how* to the dev
crowd that just clicked play and wondered "wait, a full Godot game runs in the browser?"
See [[project_wasm_devlog_launch]].

**Format:** technical writeup post. Native video is OPTIONAL here — the flagship already
showed the game. If you want a visual, a short combat-transition clip works; otherwise a
text post with the devlog link is fine (r/godot rewards substantive technical posts).

**Contextual link = the WASM devlog.** This is the post where it stops being a comment
link and becomes the headline.

## Title (pick one — technique-first, the gauntlet framing)
1. **(primary)** `Porting a real, 4-year Godot game to the web: SharedArrayBuffer headers, single-thread hangs, script-key obfuscation — the whole gauntlet, written up`
2. `What it actually takes to ship a full Godot 4 game to the browser (not a jam demo) — the web-export gotchas I hit`
3. `Godot 4 → HTML5 for a real game: the COOP/COEP + SharedArrayBuffer + pck-key headaches, and how I solved each`

## Body
```
A lot of "Godot runs in the browser!" posts are jam demos. I wanted to write up what it
takes for a *full* game — four years of tactical RPG, real save system, packs, the works
— and the web export turned into its own gauntlet. Some of what bit me:

- COOP/COEP + SharedArrayBuffer: the cross-origin-isolation headers the engine needs, and
  where they have to live (and where they break embedding).
- Single-thread vs threaded export tradeoffs and the hangs that come with getting it wrong.
- Script-encryption key handling — the web export ships the key in a way static scanners
  can read straight off disk, so I built an obfuscation step around it.
- Caching, pack loading, and the deploy pipeline that keeps it all consistent.

Full writeup with the actual fixes is linked below. Happy to go deep on any of these in
the comments — this is the stuff I wish someone had written up before I started.
```

## First comment (links)
```
The full write-up — every gotcha + fix: https://allbyte.studio/devlog/wasm-gotchas-and-web-export/
And it's playable here if you want to see the end result: https://allbyte.studio/play/
```

## Posting notes
- This is where the technical depth carries it — engage the comments more here than
  elsewhere; r/godot devs will ask sharp follow-ups and that thread *is* the value.
- Don't post this the same day as the flagship — ~1 week gap so each is its own moment.
- Cross-audience reuse: this writeup is also the **HN + dev.to** finale (not karma-gated).
  Reword for HN ("Show HN: ...") rather than copy-paste.
