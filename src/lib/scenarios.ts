/**
 * Scenario-launcher data layer.
 *
 * A "scenario" is a save file (owner ruling): loading it restores the whole
 * party + warps into the saved scene. Each row carries the minimal shape Arc
 * settled on — `label`, `packs`, `fixtureId`, optional `persona` — grouped into
 * gameplay-order `section`s.
 *
 * Source of truth: Quinn's `quinn_spine.json` (she owns the spine + the
 * referenced save fixtures). `scripts/sync-scenario-fixtures.js` mirrors the
 * rows into `src/data/scenarios.json` and copies each referenced save into
 * `public/scenario-fixtures/<fixtureId>.json` (served same-origin so the
 * launcher can fetch it without CORS and hand it to the game inline). Until
 * that sync runs against real spine data, this is an empty catalogue and the
 * page renders an empty state.
 */

import data from "../data/scenarios.json";

export interface Scenario {
  /** stable row id */
  id: string;
  /** gameplay-order grouping, e.g. "Laria Town", "Waterways" */
  section: string;
  /** human label, e.g. "Mother Slime — leveled party" */
  label: string;
  /** library save id → /scenario-fixtures/<fixtureId>.json */
  fixtureId: string;
  /** zone packs to mount before the load, e.g. ["Laria","Combat"] */
  packs: string[];
  /** optional default AutoPlay persona overlay */
  persona?: string;
  /** optional short description */
  note?: string;
}

export interface ScenarioData {
  version: number;
  generated_at: string;
  /** gameplay order of section names */
  sections: string[];
  scenarios: Scenario[];
}

export const scenarioData = data as unknown as ScenarioData;

/** Compose the /play deep-link that drops straight into the develop build. */
export function launchUrl(s: Scenario, opts?: { persona?: string }): string {
  const p = new URLSearchParams();
  p.set("channel", "develop");
  p.set("scenario", s.fixtureId);
  if (s.packs?.length) p.set("packs", s.packs.join(","));
  const persona = opts?.persona ?? s.persona;
  if (persona) p.set("persona", persona);
  return `/play/?${p.toString()}`;
}

/** Scenarios grouped by section, in the spine's gameplay order. */
export function bySection(): { section: string; scenarios: Scenario[] }[] {
  const order =
    scenarioData.sections?.length
      ? scenarioData.sections
      : [...new Set(scenarioData.scenarios.map((s) => s.section))];
  return order
    .map((section) => ({
      section,
      scenarios: scenarioData.scenarios.filter((s) => s.section === section),
    }))
    .filter((g) => g.scenarios.length > 0);
}
