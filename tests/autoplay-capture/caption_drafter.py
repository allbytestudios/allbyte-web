"""Draft platform-specific captions for each extracted clip.

Reads the clip manifest + per-clip metadata produced by clip_extractor.py,
calls Claude (Haiku 4.5) per clip to draft Bluesky / Discord / YouTube
Shorts / generic-title caption variants, and writes them back into the
per-clip JSON as `draft_captions`. The marketing-queue UI later reads
these and presents them for owner approval.

API key handling: `ANTHROPIC_API_KEY` must be in the container env. If
unset, this script skips with a friendly message — clips remain usable
without captions, captions can be drafted in a later pass.

Skipped clips can be re-processed later by re-running this script over
the same clips_dir; it overwrites `draft_captions` on each pass.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

try:
    import anthropic  # type: ignore
except ImportError:
    print("[caption] anthropic SDK not installed; install via requirements.txt", file=sys.stderr)
    sys.exit(0)


# Haiku 4.5 is the right pick here — caption drafting is small-context,
# repetitive, and benefits from speed + cost more than from intelligence
# headroom. Bump to Sonnet later if voice consistency drifts.
MODEL = os.environ.get("CAPTION_MODEL", "claude-haiku-4-5-20251001")

# System prompt is stable across all clips → prompt-cache eligible.
# Brand voice cribbed from the project's published copy (Footer, devlogs,
# subscribe page) — first-person singular, High-Tech Artisan dual identity,
# no AI-art tone-deafness, indie-transparent.
SYSTEM_PROMPT = """You're drafting social media captions for AllByte Studios, a solo-developer indie game studio.

Brand voice (load-bearing):
- First-person SINGULAR ("I", "my", "me") — solo dev. Never "we" or "us" or "our team".
- "High-Tech Artisan" identity: AI does the code and automation; art / music / fonts / writing are 100% handcrafted by the developer.
- Direct, technical, transparent — like an engineer's notebook entry, not marketing copy.
- No emoji unless the platform expects them. Discord can be more casual, Bluesky lowercase + sparse hashtags.
- Don't overclaim drama — if the clip is a routine encounter, say so honestly. The audience values transparency over hype.
- Never reference the dev's personal name; always "AllByte" or "the studio" if attribution is needed.

The game:
- Name: The Chronicles of Nesis (never abbreviate to "Chronicles")
- Genre: Fantasy tactical RPG — turn-based party combat, dungeon traversal, PS1-era aesthetic
- Engine: Godot 3.5
- Style: Pre-rendered backgrounds, sprite-based combat
- Studio: AllByte Studios

The clips come from an automated auto-play harness — the game is being played by an AI persona (Scout = avoids encounters when possible, default = engages by zone proximity). Mention this is an autoplay clip when relevant for context; don't pretend it's a human playthrough.

Output: a single JSON object with the keys requested. No preamble, no code fences, just the JSON."""


PROMPT_USER_TEMPLATE = """Clip metadata:
```json
{meta_json}
```

Draft caption variants. Output JSON with EXACTLY these keys:

- "title": ≤80 chars, headline-style. Plain sentence, no clickbait.
- "bluesky": ≤290 chars. Lowercase hashtags chosen from this set as relevant: #indiedev #godot #godotengine #tacticalrpg #jrpg #gamedev. Pick 2-3 max.
- "discord": any length 1-3 sentences, server-announcement tone, casual but not effusive. No @everyone or role mentions.
- "youtube_shorts": ≤180 chars total. Keyword-dense for discovery — "Godot tactical RPG", "indie dev", "AI autoplay" are the priorities.

Return ONLY the JSON object."""


def draft_captions(client, clip_meta: dict) -> dict:
    """One Claude call → captions JSON for one clip."""
    user_msg = PROMPT_USER_TEMPLATE.format(meta_json=json.dumps(clip_meta, indent=2))
    resp = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    text = "".join(
        block.text for block in resp.content if getattr(block, "type", None) == "text"
    ).strip()
    # Defensive: strip code fences if the model wrapped the JSON anyway.
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip("`\n")
    return json.loads(text)


def main() -> int:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("[caption] ANTHROPIC_API_KEY not set, skipping caption drafting")
        return 0

    clips_dir_env = os.environ.get("CLIPS_DIR")
    if clips_dir_env:
        clips_dir = Path(clips_dir_env)
    else:
        # Derive from MP4_PATH (the boot.sh-set output path)
        mp4_path = Path(os.environ.get("MP4_PATH", ""))
        clips_dir = mp4_path.parent / "clips" if mp4_path.name else Path("/home/pwuser/out/clips")

    manifest_path = clips_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"[caption] manifest not found at {manifest_path}; nothing to caption")
        return 0

    manifest = json.loads(manifest_path.read_text())
    clips = manifest.get("clips", [])
    if not clips:
        print("[caption] manifest has no clips; nothing to caption")
        return 0

    client = anthropic.Anthropic(api_key=api_key)
    drafted = 0
    failed = 0
    for entry in clips:
        meta_path = clips_dir / entry["meta"]
        if not meta_path.exists():
            print(f"[caption] {entry['name']}: meta file missing, skipped")
            failed += 1
            continue
        meta = json.loads(meta_path.read_text())
        try:
            captions = draft_captions(client, meta)
        except Exception as e:
            print(f"[caption] {entry['name']}: drafting failed — {type(e).__name__}: {e}")
            failed += 1
            continue
        meta["draft_captions"] = captions
        meta_path.write_text(json.dumps(meta, indent=2))
        # Mirror title into manifest entry for quick scan in the queue UI.
        entry["title"] = captions.get("title", "")
        drafted += 1
        print(f"[caption] {entry['name']}: drafted ({captions.get('title', '?')!r})")

    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"[caption] done: {drafted} drafted, {failed} failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
