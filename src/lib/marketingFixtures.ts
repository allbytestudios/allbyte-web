/**
 * Marketing-side fixture manifest data layer.
 *
 * The static JSON at src/data/marketing-fixtures.json declares what
 * marketing-relevant game states AppC wants to capture from. Each entry
 * either maps to an Arc-side save fixture (by file name) or declares a
 * gap that needs an Arc capture request.
 *
 * Reachability + validation are computed at runtime so the UI can show
 * health per entry (available / 404 / gap).
 */

import manifestData from "../data/marketing-fixtures.json";

export type FixtureCategory = "scene" | "combat" | "moment" | "menu" | "cutscene";

export interface MarketingFixtureEntry {
  id: string;
  category: FixtureCategory;
  tags: string[];
  story_beat: string;
  fixture: string | null;
  arc_cond: number | null;
  scene_anchor: string | null;
  duration_estimate_s: number;
  persona_hint: string;
  notes: string;
}

export interface MarketingFixturesManifest {
  version: number;
  description: string;
  entries: MarketingFixtureEntry[];
}

export const manifest = manifestData as unknown as MarketingFixturesManifest;

export type EntryStatus = "available" | "missing" | "gap" | "unchecked";

export interface EntryHealth {
  status: EntryStatus;
  url?: string;
  error?: string;
}

const IS_DEV = import.meta.env.DEV;

// Fixture files live in Arc's Chronicles repo. Two surfaces:
//
//   Dev:  served by chroniclesProxy at /test-data/WebTests/fixtures/saves/frontier/
//   Prod: served from S3 at /savefixtures/  (once Arc lands the publish step;
//         until then prod path 404s and AppC just shows "missing" in the UI)
const FIXTURE_BASE_DEV = "/test-data/WebTests/fixtures/saves/frontier/";
const FIXTURE_BASE_PROD = "/savefixtures/";

export function fixtureUrl(file: string): string {
  return (IS_DEV ? FIXTURE_BASE_DEV : FIXTURE_BASE_PROD) + file;
}

/** HEAD-check a fixture URL. Resolves true if the file responds 200. */
export async function fixtureReachable(file: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(fixtureUrl(file), { method: "HEAD", signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Compute health for a single entry. */
export async function checkEntry(entry: MarketingFixtureEntry, signal?: AbortSignal): Promise<EntryHealth> {
  if (!entry.fixture) {
    return { status: "gap" };
  }
  const url = fixtureUrl(entry.fixture);
  const ok = await fixtureReachable(entry.fixture, signal);
  return ok ? { status: "available", url } : { status: "missing", url, error: `${url} returned non-200` };
}

/** Compute health for every entry, in parallel. */
export async function checkAll(signal?: AbortSignal): Promise<Record<string, EntryHealth>> {
  const out: Record<string, EntryHealth> = {};
  await Promise.all(
    manifest.entries.map(async (e) => {
      out[e.id] = await checkEntry(e, signal);
    }),
  );
  return out;
}

/** Coverage summary by category. */
export interface CoverageSummary {
  total: number;
  available: number;
  missing: number;
  gaps: number;
  byCategory: Record<FixtureCategory, { total: number; available: number }>;
}

export function summarize(health: Record<string, EntryHealth>): CoverageSummary {
  const byCategory: Record<string, { total: number; available: number }> = {};
  let available = 0, missing = 0, gaps = 0;
  for (const e of manifest.entries) {
    if (!byCategory[e.category]) byCategory[e.category] = { total: 0, available: 0 };
    byCategory[e.category].total++;
    const h = health[e.id];
    if (!h) continue;
    if (h.status === "available") {
      available++;
      byCategory[e.category].available++;
    } else if (h.status === "missing") {
      missing++;
    } else if (h.status === "gap") {
      gaps++;
    }
  }
  return {
    total: manifest.entries.length,
    available,
    missing,
    gaps,
    byCategory: byCategory as CoverageSummary["byCategory"],
  };
}
