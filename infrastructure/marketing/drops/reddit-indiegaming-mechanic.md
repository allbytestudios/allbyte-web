# Drop — r/IndieGaming (Day-0 lead): the mechanic-highlight cut

The ladder's Day-0 lead (see `reddit-ladder.md`). Supersedes the generic
web-native copy for r/IndieGaming: research on what performs there says lead with
a **single satisfying mechanic** in a short native video, show-don't-sell, links
in the first comment. Our mechanic = the hand-painted pre-rendered background
*doubling as* the tactical combat grid.

## Hero video (native upload — NOT a YouTube link)
`hybrid-ruin-combat.mp4` — 24s: dwarven-ruin hand-painted exploration → crossfade
→ combat-transition (the painted scene becoming the tactical grid). Both source
clips are clean (no debug HUD). Working copy: repo `.tmp/hybrid-ruin-combat.mp4`.

Rebuild recipe (ffmpeg), from `captures/recordings/` sources:
```
ffmpeg -y -i dwarven-ruin-entrance.mp4 -i combat-transition.mp4 -filter_complex \
"[0:v]scale=1280:960:force_original_aspect_ratio=decrease,pad=1280:960:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v0];\
[1:v]scale=1280:960:force_original_aspect_ratio=decrease,pad=1280:960:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v1];\
[v0][v1]xfade=transition=fade:duration=0.7:offset=12.569[vout];[0:a][1:a]acrossfade=d=0.7[aout]" \
-map "[vout]" -map "[aout]" -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart hybrid-ruin-combat.mp4
```

## Post copy

```
TITLE:
Reviving 90s pre-rendered JRPG backgrounds — the painted scene doubles as the battlefield

BODY:
Trying to bring back the pre-rendered, hand-painted backgrounds of 90s JRPGs —
and make the scene you explore double as the tactical combat grid, so the world
you walk through is the battlefield you fight on.

It's a solo tactical RPG built in Godot 4. Free to play, and it runs right in
your browser — no download, no install.

Happy to answer anything about how the painted scenes are built to line up with
the grid. It's an in-progress build, so feedback's welcome.
```

FIRST COMMENT (post yourself right after — links go here, not the body):
```
Play it free in the browser (no download): https://allbyte.studio/play/
How the painted scenes line up with the combat grid: https://allbyte.studio/devlog/painting-around-the-grid/
```

## Posting mechanics
- **Native-upload the mp4** — Reddit favors native video; don't link YouTube.
- **Links in the first self-comment**, not the body (keeps the post clean of promo).
- **Reply to the first few commenters** in the first 30–60 min — the one engagement
  that actually moves ranking. Everything else optional.
- Title = ONE concrete hook (the video shows the seamless bg→grid, so the title
  doesn't over-explain). "Trying to…" humble framing on purpose — anti-hype tone.
- AI tone if it comes up: "I use AI for code; art/music/fonts are handcrafted" as a
  fact. Don't preach or pre-empt.

## Why this framing (research, 2026-07-01)
r/IndieGaming rewards mechanic highlights + show-don't-sell, not full trailers or
title/menu screens. Titles like "coming to Steam, wishlist in description" get
downvoted. So: short mechanic clip is the hero; "free, in your browser" is the
kicker in the body/title, not a shoved CTA; the full 60s trailer stays a
Steam/YouTube/flagship asset. See [[project_marketing_positioning]],
[[project_gameplay_trailer]].
