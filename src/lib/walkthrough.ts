/**
 * Walkthrough data layer.
 *
 * The walkthrough is an aggregation of multiple capture-session
 * "chapters" (produced by tests/autoplay-capture/chapter_extractor.py)
 * combined into a single document. Each chapter corresponds to one
 * persona run against one save fixture.
 *
 * Source of truth: src/data/walkthrough.json — committed to the repo.
 * Updates land via a batch script that runs Completionist persona against
 * every captured cond fixture, aggregates the per-capture chapter.json
 * files, and writes the consolidated walkthrough.json.
 *
 * Today (2026-06-06) the file is a skeleton — Arc's Completionist persona
 * and walk-* emit catalog aren't shipped yet. The UI renders an
 * appropriate empty-state until the data lands.
 */

import walkthroughData from "../data/walkthrough.json";

export interface SceneVisit {
  anchor: string;
  entered_at_s: number;
  exited_at_s: number;
  dwell_s: number;
  first_visit: boolean;
}

export interface Encounter {
  started_at_s: number;
  ended_at_s: number;
  duration_s: number;
  event_count: number;
  kills: number;
  skill_uses: number;
  first_event_payload?: string;
  last_event_payload?: string;
}

export interface DialogueLine {
  speaker?: string;
  listener?: string;
  text?: string;
  scene?: string;
  t?: number;
}

export interface ItemFound {
  item_id?: string;
  item_name?: string;
  scene?: string;
  source?: string;
}

export interface ClipRef {
  name: string;
  mp4: string;
  thumb: string;
}

export interface Chapter {
  id: string;
  source_mp4?: string;
  source_timeline?: string;
  persona?: string;
  duration_s?: number;
  cond_at_start: number | null;
  cond_at_end: number | null;
  scenes_visited: SceneVisit[];
  encounters: Encounter[];
  dialogue: DialogueLine[];
  items_found: ItemFound[];
  containers_opened: unknown[];
  objectives: unknown[];
  flavor_reads: unknown[];
  clips: ClipRef[];
  minimap_snapshots: unknown[];
  ai_summary: string | null;
  // AppC-editable overrides — owner can add per-chapter prose, title,
  // hero image references after a Completionist batch lands.
  title_override?: string;
  hero_image?: string;
  manual_notes?: string;
  draft?: boolean;
}

export interface Walkthrough {
  version: number;
  generated_at: string;
  description?: string;
  chapters: Chapter[];
}

export const walkthrough = walkthroughData as unknown as Walkthrough;

export function chapterTitle(c: Chapter): string {
  if (c.title_override) return c.title_override;
  const cond = c.cond_at_start ?? c.cond_at_end;
  const scenes = c.scenes_visited.map((s) => s.anchor);
  const sceneSummary = scenes.length === 0
    ? "Unknown area"
    : scenes.length === 1
      ? scenes[0]
      : `${scenes[0]} → ${scenes[scenes.length - 1]}`;
  return cond !== null && cond !== undefined
    ? `Chapter ${cond}: ${sceneSummary}`
    : sceneSummary;
}

const PROD_CAPTURES_BASE = "https://allbyte.studio/captures";

export function clipMp4Url(chapter: Chapter, clip: ClipRef): string {
  // Chapters render in prod against the durable /captures/recordings/
  // prefix if a clip has been "promoted" via the marketing queue, else
  // /captures/latest/ which is overwritten by every new capture run.
  // Today we always point at /captures/latest/; promotion-aware paths
  // come in a later iteration.
  return `${PROD_CAPTURES_BASE}/latest/clips/${clip.mp4}`;
}

export function clipThumbUrl(chapter: Chapter, clip: ClipRef): string {
  return `${PROD_CAPTURES_BASE}/latest/clips/${clip.thumb}`;
}
