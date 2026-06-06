/**
 * Marketing queue data layer.
 *
 * Reads the manifest + per-clip metadata produced by the autoplay-capture
 * pipeline (tests/autoplay-capture/clip_extractor.py + caption_drafter.py).
 *
 * Dev: served via captureLocalProxy at /captures-local/* from the local
 *      .tmp/capture-out/ directory.
 * Prod: served from S3 via CloudFront at /captures/latest/ — uploaded by
 *      tests/autoplay-capture/upload_to_s3.py at the end of each capture
 *      session run. The "latest" prefix is overwritten each run; preserve
 *      a session by re-running with CAPTURE_S3_PREFIX=captures/<id>.
 */

const IS_DEV = import.meta.env.DEV;

// Prod absolute URL through CloudFront. Same origin in prod so no CORS
// concerns; dev fetches from the local Astro dev server proxy.
const CLIPS_BASE = IS_DEV ? "/captures-local/clips/" : "/captures/latest/clips/";
const MANIFEST_URL = `${CLIPS_BASE}manifest.json`;

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

export interface PublishResult {
  ok: boolean;
  error?: string;
  integration?: { id: string; platform: string; name: string };
  stdout?: string;
  stderr?: string;
}

export interface DraftCaptionsResult {
  ok: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
  clip?: string;
}

/**
 * Trigger caption drafting via the dev-only middleware. Spawns
 * caption_drafter.py on the host, which by default shells out to
 * `claude -p` (consuming Max subscription quota). Pass clip=null to
 * draft all clips; pass a clip name to re-draft just one.
 *
 * Dev-only: needs the host's claude CLI installation.
 */
export async function draftCaptions(
  clip: string | null,
  signal?: AbortSignal,
): Promise<DraftCaptionsResult> {
  if (!IS_DEV) {
    return { ok: false, error: "Caption drafting requires the local dev server (claude CLI lives on the host)" };
  }
  try {
    const res = await fetch("/api/marketing/draft-captions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(clip ? { clip } : {}),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Publish a caption + clip to a platform via the dev-only Postiz CLI
 * middleware. Returns the result, including platform-specific error
 * messages when Postiz refuses (e.g., no integration wired for platform).
 *
 * Dev-only: in prod the middleware doesn't exist; publish() returns ok:false
 * with a clear error.
 */
export async function publishToPlatform(
  platform: string,
  content: string,
  mediaUrl: string | null,
  signal?: AbortSignal,
): Promise<PublishResult> {
  if (!IS_DEV) {
    return { ok: false, error: "Publishing requires the local dev server (Postiz runs locally)" };
  }
  try {
    const res = await fetch("/api/marketing/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ platform, content, mediaUrl }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
