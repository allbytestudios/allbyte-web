"""Draft platform-specific captions for each extracted clip.

Reads the clip manifest + per-clip metadata produced by clip_extractor.py,
calls Claude per clip to draft Bluesky / Discord / YouTube Shorts / title
variants, and writes them back into the per-clip JSON as `draft_captions`.

Two backends — CLI (default) and SDK (opt-in):

  CLI (CAPTION_BACKEND=cli, default) — shells out to `claude -p ...
  --json-schema ...` using the owner's Claude Code subscription quota.
  Designed to run on the HOST, not inside the container, since the claude
  binary + auth state live in the host's user home.

  SDK (CAPTION_BACKEND=sdk) — uses the Anthropic Python SDK with
  ANTHROPIC_API_KEY. Separate billing from the Max subscription. Available
  for headless/CI runs where a Claude Code session isn't available.

Skipped clips can be re-processed by re-running this script — it
overwrites `draft_captions` on each pass.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


# CLI backend tunables
CLI_BINARY = os.environ.get("CLAUDE_CLI", "claude")
CLI_TIMEOUT_S = int(os.environ.get("CAPTION_CLI_TIMEOUT_S", "120"))
CLI_MODEL = os.environ.get("CAPTION_CLI_MODEL", "").strip()  # blank → CLI default

# SDK backend tunables
SDK_MODEL = os.environ.get("CAPTION_SDK_MODEL", "claude-haiku-4-5-20251001")

BACKEND = os.environ.get("CAPTION_BACKEND", "cli").strip().lower()

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


# JSON Schema for the CLI's --json-schema flag — guarantees structured
# output without prompt-engineered parsing hacks.
CAPTIONS_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "maxLength": 120},
        "bluesky": {"type": "string", "maxLength": 320},
        "discord": {"type": "string", "maxLength": 2000},
        "youtube_shorts": {"type": "string", "maxLength": 220},
    },
    "required": ["title", "bluesky", "discord", "youtube_shorts"],
    "additionalProperties": False,
}


def _strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        # ```json\n{...}\n``` → take the middle block
        parts = text.split("```", 2)
        if len(parts) >= 2:
            text = parts[1]
            if text.startswith("json"):
                text = text[4:]
        text = text.strip("`\n")
    return text


def _draft_via_cli(clip_meta: dict) -> dict:
    """Use the `claude` CLI in --print mode with --json-schema for
    structured output. Consumes Claude Code subscription quota."""
    if not shutil.which(CLI_BINARY):
        raise RuntimeError(
            f"`{CLI_BINARY}` not in PATH; install Claude Code or set "
            f"CAPTION_BACKEND=sdk + ANTHROPIC_API_KEY"
        )
    user_prompt = PROMPT_USER_TEMPLATE.format(meta_json=json.dumps(clip_meta, indent=2))
    args = [
        CLI_BINARY, "-p", user_prompt,
        "--append-system-prompt", SYSTEM_PROMPT,
        "--json-schema", json.dumps(CAPTIONS_SCHEMA),
    ]
    if CLI_MODEL:
        args.extend(["--model", CLI_MODEL])
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=CLI_TIMEOUT_S,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"claude CLI exit {result.returncode}: "
            f"{(result.stderr or result.stdout)[:500]}"
        )
    return json.loads(_strip_code_fences(result.stdout))


def _draft_via_sdk(clip_meta: dict) -> dict:
    """Use the Anthropic Python SDK with ANTHROPIC_API_KEY. Separate
    billing from the Max subscription — only use when CLI isn't available
    (CI, automation without an auth'd session)."""
    try:
        import anthropic  # type: ignore
    except ImportError as e:
        raise RuntimeError("anthropic SDK not installed; pip install anthropic") from e
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("CAPTION_BACKEND=sdk but ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=api_key)
    user_msg = PROMPT_USER_TEMPLATE.format(meta_json=json.dumps(clip_meta, indent=2))
    resp = client.messages.create(
        model=SDK_MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    text = "".join(
        block.text for block in resp.content if getattr(block, "type", None) == "text"
    )
    return json.loads(_strip_code_fences(text))


def draft_captions(clip_meta: dict) -> dict:
    """Dispatch to the configured backend."""
    if BACKEND == "sdk":
        return _draft_via_sdk(clip_meta)
    if BACKEND == "cli":
        return _draft_via_cli(clip_meta)
    raise ValueError(f"Unknown CAPTION_BACKEND={BACKEND!r}; expected 'cli' or 'sdk'")


def main() -> int:
    # Pre-flight: confirm chosen backend is reachable. Skip cleanly if not
    # — matches the existing "no API key → exit 0" UX from before so the
    # smoke-test container still passes when nothing's configured.
    try:
        if BACKEND == "cli":
            if not shutil.which(CLI_BINARY):
                print(f"[caption] backend=cli but `{CLI_BINARY}` not in PATH; skipping. "
                      f"Set CAPTION_BACKEND=sdk + ANTHROPIC_API_KEY to use the API instead.")
                return 0
        elif BACKEND == "sdk":
            if not os.environ.get("ANTHROPIC_API_KEY"):
                print("[caption] backend=sdk but ANTHROPIC_API_KEY not set; skipping.")
                return 0
        else:
            print(f"[caption] unknown CAPTION_BACKEND={BACKEND!r}; skipping.", file=sys.stderr)
            return 0
    except Exception as e:
        print(f"[caption] backend check failed: {e}", file=sys.stderr)
        return 0

    clips_dir_env = os.environ.get("CLIPS_DIR")
    if clips_dir_env:
        clips_dir = Path(clips_dir_env)
    else:
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

    # Allow restricting to a single clip via CLI arg or env (used by the
    # marketing-queue UI's "Draft captions" button to re-draft one clip).
    target = None
    if len(sys.argv) > 1:
        target = sys.argv[1]
    elif os.environ.get("CAPTION_TARGET_CLIP"):
        target = os.environ["CAPTION_TARGET_CLIP"]

    drafted = 0
    failed = 0
    for entry in clips:
        if target and entry["name"] != target:
            continue
        meta_path = clips_dir / entry["meta"]
        if not meta_path.exists():
            print(f"[caption] {entry['name']}: meta file missing, skipped")
            failed += 1
            continue
        meta = json.loads(meta_path.read_text())
        try:
            captions = draft_captions(meta)
        except Exception as e:
            print(f"[caption] {entry['name']}: drafting failed — {type(e).__name__}: {e}")
            failed += 1
            continue
        meta["draft_captions"] = captions
        meta_path.write_text(json.dumps(meta, indent=2))
        entry["title"] = captions.get("title", "")
        drafted += 1
        print(f"[caption] {entry['name']}: drafted via {BACKEND} ({captions.get('title', '?')!r})")

    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"[caption] done: {drafted} drafted, {failed} failed (backend={BACKEND})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
