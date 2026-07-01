# Reddit ladder — Chronicles of Nesis (depth → browser → wasm)

Master schedule for the Reddit rollout. Strategy: depth is the proof, "playable in
your browser" is the kicker not the headline, WASM how-to is the finale. See
[[project_marketing_positioning]] and the per-post drop sheets in this folder.

## Course correction (2026-06-29) — cut the "update since the demo" foothold posts

The original ladder opened with two "update since the demo" continuity posts on
the account's prior-post subs (r/SoloDevelopment, then r/JRPG). **We're cutting
both:**

- **r/SoloDevelopment update — posted, flopped hard.** The "update since my demo"
  framing only resonates with the sliver who saw the original; to a cold scroller
  it's just "here's my game" with backstory they don't have. That framing is the
  weak part, not the sub.
- **r/JRPG update — cut, don't post.** It was the *weaker* of the two foothold
  subs historically (did worse than solo dev), and the stronger one just flopped.
  r/JRPG also has stricter self-promo rules (removal risk). Spending the best
  asset (combat-transition) there = downside with ~no upside.

**New lead = the subs where the hook stands on its own to strangers:** the
contrast — console-RPG depth that's *also* one-click browser-playable, no
download. Lead with the web-native subs, then the r/godot flagship, then the WASM
finale, then r/selfhosted (infra track). Save combat-transition for where it
lands (flagship + web-native), not a likely-flop foothold sub.

The two update sheets (`reddit-update-solodev.md`, `reddit-update-jrpg.md`) are
**retired** — kept in-folder for reference, not in the schedule below.

## Course correction #2 (2026-07-01) — r/IndieGaming leads, not r/WebGames

Evaluated r/WebGames before spending the Day-0 slot there. Findings:
- **Size:** ~139k members (+10.7%/yr). Mid-sized — but r/IndieGaming is **~493k**,
  ~3.5× larger, with a better-fit audience for a depth-first tactical RPG.
- **Signal is noisy.** It's the general-purpose browser-games sub (HTML5/puzzle/
  word/IO + self-promo dominant); "signal varies more than the idle subs because
  the topic is wider" — high variance, a slow tactical RPG competes against
  30-second casual games for attention.
- **Self-promo tenure rule (the real risk):** r/WebGames generally expects you to
  have been a community member for a while before posting your own work — it's NOT
  built for cold self-promo (unlike r/playmygame). Our account has **no r/WebGames
  history**, so a first-time self-promo there risks a filter/removal.

**So: r/IndieGaming is the new Day-0 lead.** r/WebGames drops to a *secondary*
discovery post, and only after warming the account with a few genuine comments in
the sub first (to clear the tenure expectation). Note the earlier "Account
reality" bullet assumed WebGames self-promo was safe on karma/age alone — this
supersedes that for WebGames specifically. (Data was qualitative — Reddit + the
JS stat sites block scraping; eyeball r/WebGames/new + /top before committing.)

## Account reality (u/AllByteGames, read 2026-06-24)
- ~5 months old, **38 karma, 10 contributions**, active in r/JRPG + r/SoloDevelopment.
- 2 prior posts (~5 mo ago), both the Steam-demo launch on those two subs; both got
  real threads. All comments were replies to commenters on his own posts.
- **Implication:** 5mo age + 38 karma clears new-account spam heuristics, so posting
  to fresh subs (WebGames, IndieGaming, godot) is safe. The only engagement asked is
  **reply to your own post's first commenters** — which he already does naturally.

## Pacing
~1–2 days between posts is fine for this account (spacing is now etiquette/fatigue,
not filter-dodging). Reddit stays **manual** (auto-posting gets spam-flagged);
everything below is pre-staged copy-paste.

## Schedule (revised)

Hero video: **the 60s gameplay trailer** (in production — see
`../trailer-60s-treatment.md`) becomes the hero across these once it lands;
until then use the existing clips noted below.

| Day | Sub | Drop sheet | Hero video | Contextual link |
|-----|-----|-----------|-----------|-----------------|
| 0 | **r/IndieGaming** (new lead) | `reddit-indiegaming-mechanic.md` | hybrid: dwarven-ruin → combat-transition (the painted bg becomes the grid) | links in first comment |
| 1–2 | **r/WebGames** (secondary — warm up account first; play link in body) | `reddit-web-native.md` | town-tour or dwarven-ruin | play link in body |
| optional | **r/playmygame** (built for self-promo; reciprocity culture — see sheet) | `reddit-web-native.md` | combat-transition | play link in body |
| ~3 | **r/godot — flagship** | `reddit-godot-flagship.md` | combat-transition (→ trailer) | painting-around-the-grid + wasm comment link |
| ~7 | **r/godot — WASM finale** | `reddit-godot-wasm-finale.md` | (optional clip) | wasm-gotchas devlog |
| around then | **r/selfhosted** (separate track) | `reddit-selfhosted-infra.md` | — | pay-the-platforms / self-hosting devlog |

Optional audience-fit slots anytime: r/tacticalrpg (combat clip). If r/JRPG is ever
revisited, do it as a reply in the sub's **weekly self-promo thread**, not a
top-level post — lower risk, and only if there's genuinely new craft to show.

## Constant links (two-link convention, per playbook)
- **Play (constant CTA):** https://allbyte.studio/play/
- **Contextual (varies per sub — see table):**
  - painting-around-the-grid → https://allbyte.studio/devlog/painting-around-the-grid/
  - wasm-gotchas → https://allbyte.studio/devlog/wasm-gotchas-and-web-export/
  - own-the-stack → https://allbyte.studio/devlog/pay-the-platforms-or-own-the-stack/
  - steam-to-web → https://allbyte.studio/devlog/steam-to-web/ (retired foothold sheets only)

## Videos (S3, native-upload to Reddit)
- town-tour: https://allbyte.studio/captures/recordings/town-tour-laria.mp4
- combat-transition: https://allbyte.studio/captures/recordings/combat-transition.mp4
- dwarven-ruin (DoF): https://allbyte.studio/captures/recordings/dwarven-ruin-entrance.mp4

## Universal posting notes
- Reddit favors **native video** — upload the mp4, don't link YouTube.
- Links in a **first self-comment**, not the post body (avoids new-account link
  filtering) — EXCEPT r/WebGames / r/playmygame where the play link belongs in the body.
- The one engagement that matters: **reply to your first few commenters** in the first
  30–60 min (boosts ranking). Everything else optional.
- Don't cross-post identically — reword titles per sub.
- AI tone: state "I use AI for code; art/music/fonts are handcrafted" as a fact if it
  comes up. Don't preach or pre-empt.
- **Gate (still in effect):** don't post until the game is verified sticky + working
  on the live `/play` build. Controller first-pass is live; confirm no known-bug
  regressions before driving traffic. See [[project_posting_paused]].
