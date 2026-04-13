// Types and helpers for ChroniclesOfNesis/test_roadmap.json — the milestone
// plan + per-scene status that the test dashboard renders alongside the
// live test index.
//
// Contract: TESTING_ROADMAP.md (human) + test_roadmap.json (machine).
// Generator: hand-edited by CON Claude for now; a parser may come later.
//
// Cross-reference with test_index.json:
//   - scene.test_files[] maps to TestEntry.file (filename, not leaf)
//   - release_gate is free text; parseGateTestIds() pulls pytest IDs out
//     of the prose and returns "<file>::<name>" pairs for lookup

import type { TestEntry, TestIndex } from "./testIndex";
import { statusClass } from "./testIndex";

export type MilestoneStatus =
  | "done"
  | "in_progress"
  | "planned"
  | "blocked";
export type SceneStatus = "done" | "partial" | "in_progress" | "planned" | "blocked";
export type SceneSize = "simple" | "medium" | "complex" | "mega";

export interface RoadmapSummary {
  total_scenes_in_scope: number;
  scenes_done: number;
  scenes_in_progress: number;
  scenes_planned: number;
  scenes_blocked: number;
  tests_in_suite: number;
  tests_tier1_in_suite: number;
  tests_tier2_in_suite: number;
  tests_tier3_in_suite: number;
  tests_planned_total_tier3: number;
  estimated_hours_remaining: number;
  actual_hours_spent: number;
  fraction_playable_scenes: number;
  fraction_tier3_tests: number;
}

export interface Scene {
  id: string;
  path: string;
  label: string;
  size: SceneSize;
  status: SceneStatus;
  tests_planned: number;
  tests_done: number;
  tests_xfail?: number;
  est_hours: number;
  actual_hours: number;
  notes?: string;
  test_files?: string[];
  blocker?: string;
  blocker_id?: string; // future structured field
}

export interface MilestonePart {
  id: string;
  label: string;
  scenes_total: number;
  scenes_done: number;
  scenes_partial?: number;
  tests_planned?: number;
  tests_done?: number;
  tests_xfail?: number;
  est_hours: number;
  actual_hours: number;
  scenes: Scene[];
}

export interface Milestone {
  id: string;
  label: string;
  status: MilestoneStatus;
  percent_complete: number;
  scope: string;
  est_hours_total: number;
  actual_hours: number;
  release_gate: string;
  parts: MilestonePart[];
  blocked_by?: string;
  chain_canary_test_id?: string; // future structured field
}

export interface KnownBlocker {
  id: string;
  label: string;
  impact: string;
  est_hours_to_unblock: number;
}

export interface OutOfScopeItem {
  id: string;
  label: string;
  reason: string;
  est_hours_if_added: number;
  est_tests_if_added: number;
}

export interface TestingRoadmap {
  schema_version: number;
  generated_at: string;
  generator: string;
  doc_reference?: string;
  notes?: string;
  summary: RoadmapSummary;
  milestones: Milestone[];
  out_of_scope: OutOfScopeItem[];
  known_blockers: KnownBlocker[];
}

// --- schema ---

export const ROADMAP_SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;

export function assertSupportedRoadmapSchema(r: {
  schema_version?: number;
}): void {
  if (!r || typeof r.schema_version !== "number") {
    throw new Error("test_roadmap.json: missing schema_version");
  }
  if (!ROADMAP_SUPPORTED_SCHEMA_VERSIONS.includes(r.schema_version as 1 | 2)) {
    throw new Error(
      `test_roadmap.json: schema_version ${r.schema_version} not supported`
    );
  }
}

// --- release gate parsing ---

/**
 * Extract pytest test IDs out of a free-text release_gate string.
 * Matches both `test_file.py::test_name` and plain `test_name` patterns.
 * Returns an array of {file, name} pairs.
 *
 * NOTE: prefer milestone.chain_canary_test_id when present. CON Claude added
 * that structured field specifically so we don't have to regex the prose.
 * This helper is the fallback for milestones that don't have one yet.
 */
export interface GateTestRef {
  /** The `.py` filename referenced in the gate (without directory). May be null if the gate only named the test function. */
  file: string | null;
  /** The pytest function name. */
  name: string;
  /** Leaf path if the ref came from a structured chain_canary_test_id (format `<leaf>::<name>`). Null for regex-parsed refs. */
  leaf?: string | null;
}

const GATE_WITH_FILE = /([a-zA-Z0-9_]+\.py)::(test_[a-zA-Z0-9_]+)/g;
const GATE_TEST_NAME_ONLY = /\b(test_[a-zA-Z0-9_]+)\b/g;

export function parseGateTestRefs(gate: string): GateTestRef[] {
  const refs: GateTestRef[] = [];
  const seen = new Set<string>();

  // First pass: file::name pairs (most specific).
  let m: RegExpExecArray | null;
  GATE_WITH_FILE.lastIndex = 0;
  while ((m = GATE_WITH_FILE.exec(gate))) {
    const key = `${m[1]}::${m[2]}`;
    if (!seen.has(key)) {
      refs.push({ file: m[1], name: m[2] });
      seen.add(key);
    }
  }

  // Second pass: bare test_names not already captured.
  GATE_TEST_NAME_ONLY.lastIndex = 0;
  while ((m = GATE_TEST_NAME_ONLY.exec(gate))) {
    const name = m[1];
    // Skip if it was already captured as part of a file::name pair.
    if ([...seen].some((k) => k.endsWith(`::${name}`))) continue;
    const key = `null::${name}`;
    if (!seen.has(key)) {
      refs.push({ file: null, name });
      seen.add(key);
    }
  }
  return refs;
}

export type GateStatus = "pass" | "fail" | "xfail" | "unknown" | "missing";

export interface GateCheckResult {
  ref: GateTestRef;
  test: TestEntry | null;
  status: GateStatus;
}

/**
 * Look up each gate ref in the test index and return the live status.
 * `missing` = the referenced test isn't in the index at all.
 */
export function checkGate(
  refs: GateTestRef[],
  index: TestIndex | null
): GateCheckResult[] {
  if (!index) {
    return refs.map((ref) => ({ ref, test: null, status: "unknown" as const }));
  }
  return refs.map((ref) => {
    const test = findTestByRef(ref, index);
    if (!test) return { ref, test: null, status: "missing" as const };
    const cls = statusClass(test.status);
    let status: GateStatus = "unknown";
    if (cls === "pass") status = "pass";
    else if (cls === "fail") status = "fail";
    else if (cls === "xfail") status = "xfail";
    return { ref, test, status };
  });
}

function findTestByRef(ref: GateTestRef, index: TestIndex): TestEntry | null {
  // Structured ref: match directly on id = "<leaf>::<name>".
  if (ref.leaf) {
    const id = `${ref.leaf}::${ref.name}`;
    for (const t of index.tests) {
      if (t.id === id) return t;
    }
    return null;
  }
  // Regex-parsed ref: match on function name, optionally constrained by file basename.
  for (const t of index.tests) {
    if (t.name !== ref.name) continue;
    if (ref.file) {
      const baseName = t.file.split("/").pop() ?? "";
      if (baseName !== ref.file) continue;
    }
    return t;
  }
  return null;
}

/**
 * Resolve a milestone's gate test references. Prefer the structured
 * `chain_canary_test_id` field when present; fall back to regex-parsing
 * the `release_gate` prose otherwise.
 */
export function milestoneGateRefs(m: Milestone): GateTestRef[] {
  if (m.chain_canary_test_id) {
    const idx = m.chain_canary_test_id.indexOf("::");
    if (idx > 0) {
      return [
        {
          leaf: m.chain_canary_test_id.slice(0, idx),
          name: m.chain_canary_test_id.slice(idx + 2),
          file: null,
        },
      ];
    }
  }
  return parseGateTestRefs(m.release_gate);
}

/**
 * Overall milestone gate color:
 *   - "pass" if all refs pass
 *   - "fail" if any ref fails
 *   - "xfail" if mix of pass/xfail (documented failures)
 *   - "unknown" if refs exist but none have been run (or no refs extracted)
 *   - "missing" if any ref points at a test that doesn't exist yet
 */
export type GateRollup = "pass" | "fail" | "xfail" | "unknown" | "missing";

export function rollupGate(results: GateCheckResult[]): GateRollup {
  if (results.length === 0) return "unknown";
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "missing")) return "missing";
  if (results.every((r) => r.status === "pass")) return "pass";
  if (results.some((r) => r.status === "xfail") && results.every((r) => r.status === "pass" || r.status === "xfail")) {
    return "xfail";
  }
  return "unknown";
}

// --- scene ↔ test mapping ---

/**
 * Given a scene and the live index, return all tests in the index whose file
 * matches one of the scene's test_files.
 */
export function testsForScene(
  scene: Scene,
  index: TestIndex | null
): TestEntry[] {
  if (!index || !scene.test_files || scene.test_files.length === 0) return [];
  const files = new Set(scene.test_files);
  return index.tests.filter((t) => {
    // test.file in the index is a path like "WebTests/test_foo.py".
    // Scene.test_files entries are typically basenames like "test_foo.py".
    const base = t.file.split("/").pop() ?? t.file;
    return files.has(base) || files.has(t.file);
  });
}

/**
 * Build a reverse index: file basename → list of (milestone, part, scene).
 * Useful for annotating the main test tree with milestone badges.
 */
export interface SceneRef {
  milestoneId: string;
  partId: string;
  scene: Scene;
}

export function buildFileToSceneIndex(
  roadmap: TestingRoadmap
): Map<string, SceneRef[]> {
  const map = new Map<string, SceneRef[]>();
  for (const m of roadmap.milestones) {
    for (const p of m.parts) {
      for (const s of p.scenes) {
        if (!s.test_files) continue;
        for (const f of s.test_files) {
          const existing = map.get(f) ?? [];
          existing.push({ milestoneId: m.id, partId: p.id, scene: s });
          map.set(f, existing);
        }
      }
    }
  }
  return map;
}

// --- blocker helpers ---

export interface BlockerSummary {
  blocker: KnownBlocker;
  scenes: Scene[];
  tests_blocked: number;
  hours_unlocked: number;
}

/**
 * For each known_blocker, find affected scenes by substring-matching the
 * scene.blocker prose (since CON hasn't added structured blocker_id yet).
 * When a scene has structured blocker_id, match on that directly.
 */
export function summarizeBlockers(roadmap: TestingRoadmap): BlockerSummary[] {
  return roadmap.known_blockers.map((b) => {
    const affected: Scene[] = [];
    let testsBlocked = 0;
    let hoursUnlocked = 0;
    for (const m of roadmap.milestones) {
      for (const p of m.parts) {
        for (const s of p.scenes) {
          if (s.blocker_id === b.id) {
            affected.push(s);
            testsBlocked += s.tests_planned - s.tests_done;
            hoursUnlocked += s.est_hours - s.actual_hours;
            continue;
          }
          if (s.blocker && blockerMatches(s.blocker, b)) {
            affected.push(s);
            testsBlocked += s.tests_planned - s.tests_done;
            hoursUnlocked += s.est_hours - s.actual_hours;
          }
        }
      }
    }
    return {
      blocker: b,
      scenes: affected,
      tests_blocked: testsBlocked,
      hours_unlocked: hoursUnlocked,
    };
  });
}

function blockerMatches(sceneBlockerText: string, b: KnownBlocker): boolean {
  const t = sceneBlockerText.toLowerCase();
  const id = b.id.toLowerCase().replace(/_/g, " ");
  const label = b.label.toLowerCase();
  return (
    t.includes(id) || t.includes(label.replace(/ system$/i, "")) || t.includes(label)
  );
}

// --- percent helpers ---

export function scenesDoneFractionInPart(part: MilestonePart): number {
  if (part.scenes.length === 0) return 0;
  const done = part.scenes.filter((s) => s.status === "done").length;
  return done / part.scenes.length;
}

export function hoursProgressFraction(m: Milestone): number {
  if (m.est_hours_total <= 0) return 0;
  return Math.min(1, m.actual_hours / m.est_hours_total);
}
