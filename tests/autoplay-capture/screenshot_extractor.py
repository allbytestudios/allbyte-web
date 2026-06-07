"""Extract still frames from a captured session for walkthrough review.

Pulls stills at three event classes:

  scene_entry — first frame ~1s after entering a unique scene
                (the visual establishing shot for that area)
  combat_mid  — midpoint of each combat cluster
                (showing combat UI + party + enemies)
  hero        — single representative frame near the most event-dense
                window of the session (current heuristic: peak combat
                cluster's mid-frame)

Outputs into <out>/stills/:
  still_001.png         (the actual frame)
  still_001.json        (per-still metadata: kind, t, scene_anchor, source)
  manifest.json         (index for marketing-queue UI)

Inputs are env-driven so the pipeline can chain:
  MP4_PATH      — input video
  TIMELINE_PATH — input event timeline
  STILLS_DIR    — output dir (default: <out>/stills)
  SCENE_LEAD_S  — how many seconds after scene entry to grab the frame
                  (default 1.5; gives the engine time to finish a
                  transition wipe)
  STARTUP_SKIP_S — skip events before this (matches clip_extractor)

Frames are extracted via ffmpeg in the host PATH. On Windows this is the
Gyan build that handles the same gdigrab MP4 the capture wrote.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path


SCENE_RE = re.compile(r'"scene"\s*:\s*"([^"]+)"')

SCENE_LEAD_S = float(os.environ.get("SCENE_LEAD_S", "1.5"))
STARTUP_SKIP_S = float(os.environ.get("STARTUP_SKIP_S", "22"))
COMBAT_CLUSTER_GAP_S = float(os.environ.get("CLIP_CLUSTER_GAP_S", "15"))


def _ffmpeg_frame(mp4: Path, out_png: Path, at_s: float):
    """Pull a single frame at the requested timestamp. -ss before -i seeks
    fast (keyframe-accurate); for a 60fps source that's plenty precise
    for review thumbs."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{at_s:.3f}",
        "-i", str(mp4),
        "-frames:v", "1",
        "-y", str(out_png),
    ]
    subprocess.run(cmd, check=True)


def _scene_transitions(events: list[dict]) -> list[dict]:
    """Return one entry per unique scene first-visit with its entry time.
    Uses the autoplay event payload's scene field (the same path
    chapter_extractor walks). Skips the startup window."""
    seen: set[str] = set()
    out: list[dict] = []
    for ev in events:
        if ev["kind"] != "autoplay":
            continue
        if ev["t"] < STARTUP_SKIP_S:
            continue
        m = SCENE_RE.search(ev.get("payload", ""))
        if not m:
            continue
        scene = m.group(1)
        if scene in seen:
            continue
        seen.add(scene)
        out.append({"scene": scene, "t": ev["t"]})
    return out


def _combat_clusters(events: list[dict], gap_s: float) -> list[dict]:
    """Group combat-related events into time clusters. Returns one
    dict per cluster: {start, end, midpoint}."""
    combat_kinds = {"combat", "unit_died", "skill"}
    relevant = sorted(
        (e for e in events if e["kind"] in combat_kinds and e["t"] >= STARTUP_SKIP_S),
        key=lambda e: e["t"],
    )
    clusters: list[list[dict]] = []
    current: list[dict] = []
    for ev in relevant:
        if not current or ev["t"] - current[-1]["t"] <= gap_s:
            current.append(ev)
        else:
            clusters.append(current)
            current = [ev]
    if current:
        clusters.append(current)
    return [
        {
            "start": c[0]["t"],
            "end": c[-1]["t"],
            "midpoint": (c[0]["t"] + c[-1]["t"]) / 2.0,
            "event_count": len(c),
        }
        for c in clusters
    ]


def _scene_at(scene_transitions: list[dict], t: float) -> str | None:
    """Return which scene was active at time t, by walking back through
    the scene-entry list."""
    active = None
    for st in scene_transitions:
        if st["t"] <= t:
            active = st["scene"]
        else:
            break
    return active


def main() -> int:
    mp4_path = Path(os.environ.get("MP4_PATH", ""))
    timeline_path = Path(os.environ.get("TIMELINE_PATH", ""))
    if not mp4_path.exists():
        print(f"[still] MP4 not found: {mp4_path}", file=sys.stderr)
        return 1
    if not timeline_path.exists():
        print(f"[still] timeline not found: {timeline_path}", file=sys.stderr)
        return 1

    stills_dir = Path(os.environ.get("STILLS_DIR", str(mp4_path.parent / "stills")))
    stills_dir.mkdir(parents=True, exist_ok=True)

    timeline = json.loads(timeline_path.read_text())
    events = timeline.get("events", [])
    meta = timeline.get("meta", {})
    session_duration = float(meta.get("duration_s") or 0)

    scene_transitions = _scene_transitions(events)
    combat_clusters = _combat_clusters(events, COMBAT_CLUSTER_GAP_S)

    # Build the still target list. Each target = (kind, t, scene_anchor).
    targets: list[OrderedDict] = []

    for st in scene_transitions:
        t = st["t"] + SCENE_LEAD_S
        if session_duration and t >= session_duration:
            t = max(0.0, session_duration - 0.5)
        targets.append(OrderedDict([
            ("kind", "scene_entry"),
            ("t", t),
            ("scene_anchor", st["scene"]),
            ("source", "scene-first-visit"),
        ]))

    for cl in combat_clusters:
        targets.append(OrderedDict([
            ("kind", "combat_mid"),
            ("t", cl["midpoint"]),
            ("scene_anchor", _scene_at(scene_transitions, cl["midpoint"])),
            ("source", f"combat-cluster ({cl['event_count']} events)"),
        ]))

    # Hero = densest combat cluster's midpoint, if any combat happened.
    if combat_clusters:
        hero = max(combat_clusters, key=lambda c: c["event_count"])
        targets.append(OrderedDict([
            ("kind", "hero"),
            ("t", hero["midpoint"]),
            ("scene_anchor", _scene_at(scene_transitions, hero["midpoint"])),
            ("source", f"peak-combat ({hero['event_count']} events)"),
        ]))

    if not targets:
        print("[still] no still targets found")
        (stills_dir / "manifest.json").write_text(json.dumps({
            "source_mp4": mp4_path.name,
            "source_timeline": timeline_path.name,
            "stills": [],
        }, indent=2))
        return 0

    manifest_entries: list[OrderedDict] = []
    written = 0
    for i, tgt in enumerate(targets, start=1):
        name = f"still_{i:03d}"
        out_png = stills_dir / f"{name}.png"
        out_meta = stills_dir / f"{name}.json"
        try:
            _ffmpeg_frame(mp4_path, out_png, float(tgt["t"]))
        except subprocess.CalledProcessError as e:
            print(f"[still] {name}: ffmpeg failed: {e}", file=sys.stderr)
            continue
        out_meta.write_text(json.dumps({
            "name": name,
            "source_mp4": mp4_path.name,
            **tgt,
        }, indent=2))
        manifest_entries.append(OrderedDict([
            ("name", name),
            ("png", out_png.name),
            ("meta", out_meta.name),
            ("kind", tgt["kind"]),
            ("t", float(tgt["t"])),
            ("scene_anchor", tgt["scene_anchor"]),
        ]))
        written += 1
        print(f"[still] {name} t={tgt['t']:.1f}s kind={tgt['kind']} scene={tgt['scene_anchor']!r}")

    (stills_dir / "manifest.json").write_text(json.dumps({
        "source_mp4": mp4_path.name,
        "source_timeline": timeline_path.name,
        "persona": meta.get("persona"),
        "session_duration_s": session_duration,
        "stills": manifest_entries,
    }, indent=2))
    print(f"[still] done: {written} stills written to {stills_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
