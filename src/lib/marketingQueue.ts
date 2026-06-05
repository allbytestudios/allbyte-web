/**
 * Marketing queue data layer.
 *
 * Reads the manifest + per-clip metadata produced by the autoplay-capture
 * pipeline (tests/autoplay-capture/clip_extractor.py + caption_drafter.py).
 *
 * Dev: served via the captureLocalProxy at /captures-local/* from the
 *      local .tmp/capture-out/ directory.
 * Prod (future): same URL shape, but served from S3 once the upload step
 *      lands in boot.sh. UI doesn't care which.
 */

const MANIFEST_URL = "/captures-local/clips/manifest.json";
const CLIPS_BASE = "/captures-local/clips/";

export interface DraftCaptions {
  title?: string;
  bluesky?: string;
  discord?: string;
  youtube_shorts?: string;
}

export interface ClipMeta {
  name: string;
  source_mp4: string;
  start_s: number;
  end_s: number;
  duration_s: number;
  event_count: number;
  first_event: string;
  last_event: string;
  scene_hint?: string;
  persona?: string;
  clip_window: { start_s: number; end_s: number; duration_s: number };
  draft_captions?: DraftCaptions;
}

export interface ManifestEntry {
  name: string;
  mp4: string;
  thumb: string;
  meta: string;
  title?: string;
}

export interface Manifest {
  source_mp4: string;
  source_timeline: string;
  persona?: string;
  session_duration_s?: number;
  clips: ManifestEntry[];
}

export async function fetchManifest(signal?: AbortSignal): Promise<Manifest | null> {
  try {
    const res = await fetch(MANIFEST_URL, { signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchClipMeta(metaFile: string, signal?: AbortSignal): Promise<ClipMeta | null> {
  try {
    const res = await fetch(`${CLIPS_BASE}${metaFile}`, { signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function clipMp4Url(mp4File: string): string {
  return `${CLIPS_BASE}${mp4File}`;
}

export function clipThumbUrl(thumbFile: string): string {
  return `${CLIPS_BASE}${thumbFile}`;
}
