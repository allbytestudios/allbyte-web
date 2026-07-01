# Trailer treatment — "This is what playing Chronicles of Nesis feels like" (~60s)

**Goal:** one hero asset that shows the *depth* — a hand-painted 1990s-style
tactical RPG with a real world, story, growth systems, and combat — with the
kicker that it's one-click browser-playable. Depth is the proof; "no download"
is the last beat, not the headline. Becomes the lead asset for the r/godot
flagship, r/WebGames, Steam, and YouTube (replaces the single combat clip).

Companion capture spec for Quinn: `APP_CLAUDE_QUINN_TRAILER_CAPTURE.md` (GameDev
coord dir). Positioning: [[project_marketing_positioning]]. Fixtures:
`src/data/marketing-fixtures.json`.

## Format
- **Master:** 16:9, ~60s, 1080p. Handcrafted AllByte music bed (NOT AI). Clean
  game SFX optional under the music; no VO.
- **Pulls (later, from the master):** ~30s cut for Reddit/Threads autoplay; 9:16
  for Shorts/TikTok.
- **On-screen text:** sparse, a few short cards (see beats). Typeface = ModernGoth
  (AllByteCustom) to match the brand. 90s-JRPG framing in the copy.

## Beat sheet (timings approximate — cut to the music)

| # | Time | Beat | Source (fixture / asset) | On-screen text |
|---|------|------|--------------------------|----------------|
| 0 | 0:00–0:04 | **Cold open — atmosphere.** Hold on a painted vista; music swells. | Title/atmosphere hold; `cloud-shadows Laria MainSquare` | "A tactical RPG in the 1990s tradition." |
| 1 | 0:04–0:15 | **A world to explore.** Town walk → into the windmill → verticality. (Windmill = town, scored Laria.) | `town-introduction` → `windmill-interior` → `windmill-second-floor` | "Hand-painted. Explorable." |
| 2 | 0:15–0:24 | **A story, through its people.** Dialogue beat with portraits. | `mayors-house-report` or `church-square-slime-summoning` (Naphtali & Elias) | "A story told through its people." |
| 3a | 0:24–0:32 | **Down into the waterways + a find.** From inside the windmill, the entrance to the waterways — descend into the dungeon (theme shift Laria→Dungeon), and **open a treasure chest** (dungeon, not town). | `waterway-entry-combat` (approach, pre-engage) + a chest interaction | "…and beneath it, the dark." |
| 3b | 0:32–0:39 | **The world becomes a battlefield.** Flows into the grid; a skill cast + a poison status effect. | `waterway-entry-combat` (engage) → `combat-transition.mp4` (existing) | "Then the world becomes a battlefield." |
| 4 | 0:39–0:50 | **Grow.** Level-up flourish → open the **skill tree**, **click a specific skill node so its detail shows**, then **navigate across to the status screen** (stats/equipment). Show the menus being *used*, not held static. | `level-up-moment` → `_testOpenMenu='skilltree'` (+ select a node) → nav to `'status'` | "Level up. Branch a skill tree. Gear your party." |
| 5 | 0:49–0:56 | **It gets bigger.** Boss approach + intro. | `first-boss-encounter` (SluiceGate) | "And then it gets bigger." |
| 6 | 0:56–1:00 | **End card / CTA.** Title lockup; the kicker. | Title lockup | "Chronicles of Nesis — free in your browser. No download. allbyte.studio/play/" |

## Assets we already have (reuse)
- `combat-transition.mp4` — beat 3 core (the strongest "real game" hook).
- `dwarven-ruin-entrance.mp4` (DoF showpiece), `town-tour-laria.mp4` — B-roll for
  beats 1/3 if the fresh captures need padding.

## Capture GAPS (need Quinn/Arc to author fixtures — see the Quinn doc)
- **beat 4 growth:** `level-up-moment` (needs a hand-crafted XP≈99/100 fixture),
  `status-menu-showcase` + **equipment** (drops from cond 12–15; menu via
  `_testOpenMenu`). Skill tree hook = `_testOpenMenu='skilltree'`.
- **beat 5 boss:** `first-boss-encounter` — falls out when Arc's Tier 5 reaches
  SluiceGate (cond 12–14). No fixture yet.

Everything in beats 0–3 is capturable **today** from existing cond_01–cond_11
fixtures on the clean public build.

## Music — scene-native scoring (AllByte's direction)
No single bed. The trailer uses the game's **own themes**, matched to whatever
scene is on screen — so it literally sounds like playing. Themes are AllByte's
handcrafted tracks (`/assets/music/*.ogg`):

| Beat | On screen | Theme |
|------|-----------|-------|
| 0 | Title / cold open | **Anthem2** (opening anthem) |
| 1 (town + windmill) / 2 (dialogue) / 4 (menus) | Laria town, windmill interior, NPCs, skill-tree/equipment menus | **Laria** (town theme — the windmill is still town) |
| 3a | Waterways (the dungeon — entered from inside the windmill) | **Dungeon** |
| 3b | Grid combat | **BattleTheme** |
| 5 | Boss | **ImpendingConclusion** |
| 6 | End card / CTA | **Victory** (or an Anthem swell) |

**Edit implication:** group footage so theme changes are few and land on real
scene cuts (title→town→dungeon→combat→boss→end), and crossfade at the seams. The
menu/skill-tree beat is scored with the town theme (per direction: "menu shots =
town theme"), so it sits musically next to the town/story material even though it
narratively follows combat — resolve in the edit.

**Audio source:** ideally Quinn captures clean **in-game audio**, so each beat
carries its native theme (and the game's own transitions) for free. If capture is
silent, I mux the matching `.ogg` per beat — we already ship all these tracks, so
this is not a blocker either way.

## Production order
1. Lock music track + tone (AllByte).
2. Quinn captures beats 0–3 now (clean public build); authors fixtures for the
   beat-4/5 gaps, then captures those.
3. I assemble the 60s master (clips + text cards + music), review, then derive
   the 30s + 9:16 pulls.
