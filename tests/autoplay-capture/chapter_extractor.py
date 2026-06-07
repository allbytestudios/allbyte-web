"""Aggregate a single capture's timeline + clips into a walkthrough chapter.

Reads the timeline.json + clips/ manifest produced by clip_extractor.py
and emits a chapter.json structured for the /walkthrough/ page. Each
chapter represents one capture session (one cond fixture, one persona run).

Schema is intentionally conservative — when Arc's Completionist + walk-*
events ship, this script will pull richer fields. Today it produces what
the existing console-grep events support:

  - persona + duration + cond hint (from timeline meta)
  - scenes visited (parsed from autoplay event payloads)
  - encounter summary (combat + unit_died clusters)
  - dialogue + items + flavor reads (TODO — wait for walk-* emits)
  - clip refs (mp4 + thumb per cluster)

When walkthrough.json eventually aggregates many chapter.json files, the
empty fields fill in as Arc lands the corresponding emit categories.

Run env vars (set by run_capture.ps1 or manually):
  MP4_PATH          input video
  TIMELINE_PATH     input timeline
  CLIPS_DIR         clip output dir (clips already extracted)
  CHAPTERS_DIR      where to write chapter.json (default: alongside CLIPS_DIR)
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any


SCENE_RE = re.compile(r'"scene"\s*:\s*"([^"]+)"')
COND_RE = re.compile(r'"cond"\s*:\s*(\d+)')


def _parse_scene(payload: str) -> str | None:
    m = SCENE_RE.search(payload or "")
    return m.group(1) if m else None


def _parse_cond(payload: str) -> int | None:
    m = COND_RE.search(payload or "")
    return int(m.group(1)) if m else None


def _build_scenes_visited(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Walk the autoplay events in order, build a list of unique scene
    entries with enter/exit timestamps + dwell. Idea: scene changes when
    `scene` field in the payload changes."""
    scenes: list[dict[str, Any]] = []
    current_scene: str | None = None
    current_start: float = 0.0
    for ev in events:
        if ev["kind"] != "autoplay":
            continue
        scene = _parse_scene(ev.get("payload", ""))
        if not scene:
            continue
        if scene == current_scene:
            continue
        # Scene transition — close previous, open new.
        if current_scene is not None:
            scenes.append({
                "anchor": current_scene,
                "entered_at_s": current_start,
                "exited_at_s": ev["t"],
                "dwell_s": ev["t"] - current_start,
                "first_visit": True,  # placeholder — Arc's walk-* gives the real signal
            })
        current_scene = scene
        current_start = ev["t"]
    if current_scene is not None:
        last_t = events[-1]["t"] if events else current_start
        scenes.append({
            "anchor": current_scene,
            "entered_at_s": current_start,
            "exited_at_s": last_t,
            "dwell_s": last_t - current_start,
            "first_visit": True,
        })
    return scenes


def _build_encounters(events: list[dict[str, Any]], gap_s: float = 15.0) -> list[dict[str, Any]]:
    """Group combat / unit_died / skill events into encounters. One
    encounter = one combat cluster with metadata."""
    combat_kinds = {"combat", "unit_died", "skill"}
    related = sorted(
        (e for e in events if e["kind"] in combat_kinds),
        key=lambda e: e["t"],
    )
    encounters: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for ev in related:
        if not current or ev["t"] - current[-1]["t"] <= gap_s:
            current.append(ev)
        else:
            encounters.append(current)
            current = [ev]
    if current:
        encounters.append(current)
    out = []
    for cluster in encounters:
        kills = sum(1 for e in cluster if e["kind"] == "unit_died")
        skill_uses = sum(1 for e in cluster if e["kind"] == "skill")
        out.append({
            "started_at_s": cluster[0]["t"],
            "ended_at_s": cluster[-1]["t"],
            "duration_s": cluster[-1]["t"] - cluster[0]["t"],
            "event_count": len(cluster),
            "kills": kills,
            "skill_uses": skill_uses,
            "first_event_payload": cluster[0].get("payload", "")[:200],
            "last_event_payload": cluster[-1].get("payload", "")[:200],
        })
    return out


def _walk_event_groups(events: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Bucket walk-* events by their tail (walk-scene-entered, walk-dialogue,
    walk-item-found, etc.). All buckets will be empty until Arc ships
    Completionist + the walk-* emit catalog."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for ev in events:
        if not ev["kind"].startswith("walk-"):
            continue
        tail = ev["kind"][len("walk-"):]
        groups.setdefault(tail, []).append(ev)
    return groups


def _cond_hint(events: list[dict[str, Any]]) -> tuple[int | None, int | None]:
    """Pull start + end cond from autoplay event payloads."""
    first_cond: int | None = None
    last_cond: int | None = None
    for ev in events:
        if ev["kind"] != "autoplay":
            continue
        c = _parse_cond(ev.get("payload", ""))
        if c is None:
            continue
        if first_cond is None:
            first_cond = c
        last_cond = c
    return first_cond, last_cond


def main() -> int:
    timeline_path = Path(os.environ.get("TIMELINE_PATH", ""))
    if not timeline_path.exists():
        print(f"[chapter] timeline not found: {timeline_path}", file=sys.stderr)
        return 1
    mp4_path = Path(os.environ.get("MP4_PATH", ""))
    clips_dir_env = os.environ.get("CLIPS_DIR")
    clips_dir = Path(clips_dir_env) if clips_dir_env else (mp4_path.parent / "clips" if mp4_path.name else Path("/tmp"))
    chapters_dir = Path(os.environ.get("CHAPTERS_DIR", str(clips_dir.parent / "chapters")))
    chapters_dir.mkdir(parents=True, exist_ok=True)

    timeline = json.loads(timeline_path.read_text())
    events = timeline.get("events", [])
    meta = timeline.get("meta", {})

    scenes = _build_scenes_visited(events)
    encounters = _build_encounters(events)
    walk_groups = _walk_event_groups(events)
    first_cond, last_cond = _cond_hint(events)

    # Reference clips via manifest if it exists; harness clips are at
    # /captures/recordings/ or /captures/latest/ in serving terms.
    clip_refs: list[dict[str, str]] = []
    clip_manifest = clips_dir / "manifest.json"
    if clip_manifest.exists():
        try:
            cm = json.loads(clip_manifest.read_text())
            for entry in cm.get("clips", []):
                clip_refs.append({
                    "name": entry.get("name", ""),
                    "mp4": entry.get("mp4", ""),
                    "thumb": entry.get("thumb", ""),
                })
        except Exception:
            pass

    # Chapter id keys are derived from the source MP4 name.
    chapter_id = mp4_path.stem if mp4_path.name else timeline_path.stem.replace(".timeline", "")

    chapter = OrderedDict([
        ("id", chapter_id),
        ("source_mp4", mp4_path.name if mp4_path else ""),
        ("source_timeline", timeline_path.name),
        ("persona", meta.get("persona")),
        ("duration_s", meta.get("duration_s")),
        ("cond_at_start", first_cond),
        ("cond_at_end", last_cond),
        ("scenes_visited", scenes),
        ("encounters", encounters),
        # walk-* derived fields — empty until Arc lands Completionist.
        ("dialogue", walk_groups.get("dialogue", [])),
        ("items_found", walk_groups.get("item-found", [])),
        ("containers_opened", walk_groups.get("container-opened", [])),
        ("objectives", walk_groups.get("objective-set", []) + walk_groups.get("objective-complete", [])),
        ("flavor_reads", walk_groups.get("flavor-read", [])),
        ("clips", clip_refs),
        ("minimap_snapshots", []),  # populated when minimap hook lands
        ("ai_summary", None),  # filled in later by Claude CLI
    ])

    out_path = chapters_dir / f"{chapter_id}.chapter.json"
    out_path.write_text(json.dumps(chapter, indent=2))
    print(f"[chapter] wrote {out_path.name} — scenes={len(scenes)} encounters={len(encounters)} clips={len(clip_refs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
