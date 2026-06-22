"""Cut highlight clips from a captured autoplay session.

Reads the MP4 + timeline.json produced by run.py / boot.sh and emits a set of
short clips (MP4 + thumbnail PNG + per-clip metadata JSON) suitable for
marketing-queue review.

v1 heuristic: combat clusters are the primary marketing-interesting moments.
Group consecutive `[combat]` log events that fire within CLUSTER_GAP_S of
each other, treat each cluster as one combat encounter, cut a clip with
3-second lead/lag padding around it.

Output:
    out/clips/clip_NNN.mp4
    out/clips/clip_NNN.thumb.png
    out/clips/clip_NNN.json

Inputs are env-var driven so boot.sh can chain seamlessly:
    MP4_PATH         — input video (full session)
    TIMELINE_PATH    — input event timeline JSON
    CLIPS_DIR        — output directory (default: <out>/clips)
    STARTUP_SKIP_S   — skip events in the first N seconds (AutoPlay startup
                       delay, Arc-known quirk). Default 22.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# Tunables. Conservative defaults; can be overridden by env.
CLUSTER_GAP_S = float(os.environ.get("CLIP_CLUSTER_GAP_S", "15"))
LEAD_S = float(os.environ.get("CLIP_LEAD_S", "3"))
LAG_S = float(os.environ.get("CLIP_LAG_S", "3"))
MIN_CLIP_S = float(os.environ.get("CLIP_MIN_DURATION_S", "5"))
MAX_CLIP_S = float(os.environ.get("CLIP_MAX_DURATION_S", "60"))


def _cluster_events(events, kinds, gap_s):
    """Group consecutive events of any of the given kinds into time clusters.

    `kinds` is a string (single kind) or a set/tuple of kinds — both forms
    accepted so the extractor can group combat-related signals together
    (e.g., '[combat]' AND `unit_died` events form one combat cluster)."""
    if isinstance(kinds, str):
        kind_set = {kinds}
    else:
        kind_set = set(kinds)
    filtered = sorted(
        (e for e in events if e["kind"] in kind_set),
        key=lambda e: e["t"],
    )
    clusters = []
    current = []
    for ev in filtered:
        if not current:
            current = [ev]
            continue
        if ev["t"] - current[-1]["t"] <= gap_s:
            current.append(ev)
        else:
            clusters.append(current)
            current = [ev]
    if current:
        clusters.append(current)
    return [
        {"start": c[0]["t"], "end": c[-1]["t"], "events": c}
        for c in clusters
    ]


def _ffmpeg_clip(input_mp4: Path, out_mp4: Path, start_s: float, duration_s: float):
    """Cut a clip from input_mp4. Re-encodes for frame-accurate boundaries.

    -r 60 preserves the source 60fps rate; without it libx264 defaults to 30
    and duplicates/drops frames. Source MP4 must be 60fps for this to be
    correct."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start_s:.3f}",
        "-i", str(input_mp4),
        "-t", f"{duration_s:.3f}",
        "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
        "-r", "60",
        "-c:a", "aac", "-b:a", "128k",
        "-y", str(out_mp4),
    ]
    subprocess.run(cmd, check=True)


def _ffmpeg_thumbnail(input_mp4: Path, out_png: Path, at_s: float):
    """Extract a single frame as PNG. Used as the clip's poster image."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{at_s:.3f}",
        "-i", str(input_mp4),
        "-vframes", "1",
        "-y", str(out_png),
    ]
    subprocess.run(cmd, check=True)


def _summarize_cluster(cluster, meta):
    """Build human-readable summary fields for the per-clip JSON.

    v1 just counts event types and reports timing. Caption drafter (later
    pass) is responsible for narrative prose — we just hand it structured
    facts here."""
    events = cluster["events"]
    return {
        "start_s": cluster["start"],
        "end_s": cluster["end"],
        "duration_s": cluster["end"] - cluster["start"],
        "event_count": len(events),
        "first_event": events[0].get("payload", ""),
        "last_event": events[-1].get("payload", ""),
        "scene_hint": meta.get("scene"),
        "persona": meta.get("persona"),
    }


def main() -> int:
    mp4_path = Path(os.environ.get("MP4_PATH", ""))
    timeline_path = Path(os.environ.get("TIMELINE_PATH", ""))
    if not mp4_path.exists():
        print(f"[clip] MP4 not found: {mp4_path}", file=sys.stderr)
        return 1
    if not timeline_path.exists():
        print(f"[clip] timeline not found: {timeline_path}", file=sys.stderr)
        return 1

    clips_dir = Path(os.environ.get("CLIPS_DIR", str(mp4_path.parent / "clips")))
    clips_dir.mkdir(parents=True, exist_ok=True)

    timeline = json.loads(timeline_path.read_text())
    events = timeline.get("events", [])
    meta = timeline.get("meta", {})
    startup_skip_s = float(os.environ.get(
        "STARTUP_SKIP_S",
        str(meta.get("startup_skip_s", 22)),
    ))
    session_duration = float(meta.get("duration_s", 0))

    # Whole-clip mode (title/showcase captures): there are no combat events
    # to cluster on — the entire recording IS the clip. Emit it as a single
    # reviewable clip so it lands in the marketing queue. Used by the
    # title-hold capture path (run.py --mode title).
    if os.environ.get("CAPTURE_WHOLE_CLIP") == "1":
        label = os.environ.get("CAPTURE_CLIP_LABEL", "showcase")
        full = session_duration if session_duration > 0 else MAX_CLIP_S
        clip_start = 0.0
        clip_duration = min(full, MAX_CLIP_S) if MAX_CLIP_S else full
        clip_end = clip_start + clip_duration
        clip_name = "clip_001"
        out_mp4 = clips_dir / f"{clip_name}.mp4"
        out_thumb = clips_dir / f"{clip_name}.thumb.png"
        out_meta = clips_dir / f"{clip_name}.json"
        print(f"[clip] whole-clip ({label}) 0.0s..{clip_duration:.1f}s -> {out_mp4.name}")
        _ffmpeg_clip(mp4_path, out_mp4, clip_start, clip_duration)
        _ffmpeg_thumbnail(mp4_path, out_thumb, clip_duration / 2)
        clip_meta = {
            "name": clip_name,
            "source_mp4": mp4_path.name,
            "label": label,
            "start_s": clip_start,
            "end_s": clip_end,
            "duration_s": clip_duration,
            "event_count": 0,
            "scene_hint": label,
            "persona": meta.get("persona"),
            "clip_window": {"start_s": clip_start, "end_s": clip_end, "duration_s": clip_duration},
        }
        out_meta.write_text(json.dumps(clip_meta, indent=2))
        (clips_dir / "manifest.json").write_text(json.dumps({
            "source_mp4": mp4_path.name,
            "source_timeline": timeline_path.name,
            "persona": meta.get("persona"),
            "session_duration_s": session_duration,
            "clips": [{
                "name": clip_name,
                "mp4": out_mp4.name,
                "thumb": out_thumb.name,
                "meta": out_meta.name,
            }],
        }, indent=2))
        print(f"[clip] done: 1 whole-clip written to {clips_dir}")
        return 0

    # Filter out the AutoPlay startup window — Arc-known 22s before first
    # movement; clips taken from that window are static.
    relevant = [e for e in events if e["t"] >= startup_skip_s]

    # Cluster on any combat-signal: [combat] log lines + unit_died kills +
    # [skill] cast events all count as "combat happening." Empirically the
    # current build's combat log fires unit_died reliably; [combat] tag is
    # less consistent. Grouping all three captures combat regardless of
    # which channel is the noisy one in any given build.
    clusters = _cluster_events(relevant, ("combat", "unit_died", "skill"), CLUSTER_GAP_S)
    if not clusters:
        print("[clip] no combat clusters found; nothing to extract")
        # Write an empty manifest so the marketing queue knows the session
        # was processed but produced no clips.
        (clips_dir / "manifest.json").write_text(json.dumps({
            "source_mp4": mp4_path.name,
            "source_timeline": timeline_path.name,
            "clips": [],
        }, indent=2))
        return 0

    manifest_clips = []
    for i, cluster in enumerate(clusters, start=1):
        raw_start = cluster["start"] - LEAD_S
        raw_end = cluster["end"] + LAG_S
        clip_start = max(0.0, raw_start)
        clip_end = min(session_duration if session_duration > 0 else raw_end, raw_end)
        clip_duration = clip_end - clip_start
        if clip_duration < MIN_CLIP_S:
            print(f"[clip] {i:03d} skipped — too short ({clip_duration:.1f}s)")
            continue
        if clip_duration > MAX_CLIP_S:
            print(f"[clip] {i:03d} clamping {clip_duration:.1f}s -> {MAX_CLIP_S:.1f}s")
            clip_duration = MAX_CLIP_S
            clip_end = clip_start + clip_duration

        clip_name = f"clip_{i:03d}"
        out_mp4 = clips_dir / f"{clip_name}.mp4"
        out_thumb = clips_dir / f"{clip_name}.thumb.png"
        out_meta = clips_dir / f"{clip_name}.json"

        print(f"[clip] {i:03d} cutting {clip_start:.1f}s..{clip_end:.1f}s ({clip_duration:.1f}s) -> {out_mp4.name}")
        _ffmpeg_clip(mp4_path, out_mp4, clip_start, clip_duration)
        _ffmpeg_thumbnail(mp4_path, out_thumb, clip_start + clip_duration / 2)

        clip_meta = {
            "name": clip_name,
            "source_mp4": mp4_path.name,
            **_summarize_cluster(cluster, meta),
            "clip_window": {"start_s": clip_start, "end_s": clip_end, "duration_s": clip_duration},
        }
        out_meta.write_text(json.dumps(clip_meta, indent=2))
        manifest_clips.append({
            "name": clip_name,
            "mp4": out_mp4.name,
            "thumb": out_thumb.name,
            "meta": out_meta.name,
        })

    # Manifest is what the marketing-queue UI reads to enumerate clips.
    (clips_dir / "manifest.json").write_text(json.dumps({
        "source_mp4": mp4_path.name,
        "source_timeline": timeline_path.name,
        "persona": meta.get("persona"),
        "session_duration_s": session_duration,
        "clips": manifest_clips,
    }, indent=2))

    print(f"[clip] done: {len(manifest_clips)} clips written to {clips_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
