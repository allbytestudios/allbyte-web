// Types and helpers for consuming ChroniclesOfNesis/test_index.json.
// Contract: C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis/TEST_API_CONTRACT.md
//
// IMPORTANT: the `tier` field here is RUNNER TIER (1=GUT, 2=GUT-integration,
// 3=Playwright), not the marker-tree tier from TEST_ARCHITECTURE.md. The tree
// structure comes from `leaf` (e.g. "world.save_load"), not from `tier`.

export type TestStatus =
  | "passing"
  | "failing"
  | "xfail"
  | "xpass"
  | "skipped"
  | "pending"
  | "unknown";

export type RunnerTier = 1 | 2 | 3;
export type TestShape = "A" | "B" | "C" | null;
export type LeafPriority = "P0" | "P1" | "B" | string;

export type TestOutcome =
  | "passed"
  | "failed"
  | "xfailed"
  | "xpassed"
  | "skipped"
  | "error"
  | "aborted";

export interface TestRun {
  timestamp: string;
  duration_ms: number;
  outcome: TestOutcome;
}

export interface TestHistoryEntry {
  run_id: string;
  outcome: TestOutcome;
  duration_ms: number;
}

export interface TestArtifacts {
  screenshots: string[];
  logs: string[];
  video: string | null;
}

export interface TestEntry {
  id: string;
  tier: RunnerTier;
  shape: TestShape;
  leaf: string;
  file: string;
  line: number;
  name: string;
  description: string | null;
  markers: string[];
  fixture: string | null;
  status: TestStatus;
  last_run: TestRun | null;
  artifacts: TestArtifacts;
  history: TestHistoryEntry[];
  links: {
    source: string;
    catalog_entry: string | null;
  };
}

export interface TestLeaf {
  leaf: string;
  priority?: LeafPriority;
  covered: number;
  planned: number;
  blocked: number;
  description: string;
  files?: string[];
  xfailed_bugs?: number;
  dependencies?: string[];
}

export interface TestBug {
  id: string;
  title: string;
  severity: string;
  discovered_by_test?: string;
  file?: string;
  xfail_tests?: string[];
  first_seen?: string;
  status?: string;
  fix_commit?: string | null;
}

export interface TestRunSummary {
  run_id: string;
  timestamp: string;
  trigger?: string;
  command?: string;
  duration_seconds: number;
  counts: Record<string, number>;
  failures: string[];
  commit: string;
}

export interface TestIndex {
  schema_version: number;
  generated_at: string;
  generator: string;
  repo: { name: string; commit: string; branch: string };
  summary: {
    total_tests: number;
    by_tier: Record<string, number>;
    by_status: Record<string, number>;
    last_full_run_seconds: number | null;
  };
  tests: TestEntry[];
  leaves: TestLeaf[];
  bugs: TestBug[];
  runs: TestRunSummary[];
}

// Live runtime state from TEST_API_REALTIME.md — test_run_status.json.
export interface WorkerLane {
  worker: string;
  current_test: string | null;
  started_at: string | null;
  tests_completed: number;
  last_outcome: TestOutcome | null;
  last_finished_at: string | null;
}

export interface RunProgress {
  completed: number;
  total: number;
  passed_so_far: number;
  failed_so_far: number;
  xfailed_so_far: number;
  percent: number;
  eta_seconds: number | null;
}

export interface RecentFinish {
  test_id: string;
  outcome: TestOutcome;
  duration_ms: number;
  finished_at: string;
}

export interface TestRunStatus {
  schema_version: number;
  state: "idle" | "running" | "finished" | "aborted";
  run_id: string | null;
  started_at: string | null;
  updated_at: string | null;
  workers: WorkerLane[];
  progress: RunProgress | null;
  recent_finishes: RecentFinish[];
}

// --- schema guard ---

export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

export function assertSupportedSchema(index: { schema_version?: number }): void {
  if (!index || typeof index.schema_version !== "number") {
    throw new Error("test_index.json: missing schema_version");
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(index.schema_version as 1)) {
    throw new Error(
      `test_index.json: schema_version ${index.schema_version} not supported (expected: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`
    );
  }
}

// --- tree helpers ---

export interface LeafNode {
  /** Full leaf path, e.g. "world.save_load" or "world". */
  path: string;
  /** Just the leaf's own segment, e.g. "save_load" or "world". */
  segment: string;
  /** Depth from the root (domain=0, subsystem=1, ...). */
  depth: number;
  /** Child leaf nodes, keyed by segment, sorted alphabetically for stability. */
  children: LeafNode[];
  /** Tests that live exactly at this leaf (not in a descendant). */
  tests: TestEntry[];
  /** Leaf metadata from `leaves[]` when available (subsystem leaves have this). */
  meta: TestLeaf | null;
}

function getOrMakeChild(parent: LeafNode, segment: string): LeafNode {
  let child = parent.children.find((c) => c.segment === segment);
  if (!child) {
    const path = parent.path ? `${parent.path}.${segment}` : segment;
    child = {
      path,
      segment,
      depth: parent.depth + 1,
      children: [],
      tests: [],
      meta: null,
    };
    parent.children.push(child);
  }
  return child;
}

/**
 * Build a nested leaf tree from a flat list of tests + the index's leaves[] table.
 * Tests whose `leaf` is just a domain (e.g. "world") attach at the domain node.
 * Tests whose `leaf` is nested (e.g. "world.save_load") walk down.
 * Leaves with meta but no tests are still materialized so the tree covers
 * planned-but-not-yet-implemented subsystems.
 */
export function buildLeafTree(tests: TestEntry[], leaves: TestLeaf[]): LeafNode[] {
  const root: LeafNode = {
    path: "",
    segment: "",
    depth: -1,
    children: [],
    tests: [],
    meta: null,
  };
  for (const test of tests) {
    const segments = test.leaf.split(".");
    let node = root;
    for (const seg of segments) {
      node = getOrMakeChild(node, seg);
    }
    node.tests.push(test);
  }
  // Materialize leaves from the leaves[] table even if no tests live at them.
  for (const leaf of leaves) {
    const segments = leaf.leaf.split(".");
    let node = root;
    for (const seg of segments) {
      node = getOrMakeChild(node, seg);
    }
    node.meta = leaf;
  }
  // Attach meta from leaves[] where the path matches exactly.
  const metaByPath = new Map(leaves.map((l) => [l.leaf, l]));
  const attach = (node: LeafNode) => {
    if (metaByPath.has(node.path)) {
      node.meta = metaByPath.get(node.path)!;
    }
    for (const child of node.children) attach(child);
  };
  for (const child of root.children) attach(child);
  // Stable sort children: priority-first where available (P0 > P1 > B > rest),
  // then alphabetical.
  const priorityRank: Record<string, number> = { P0: 0, P1: 1, B: 2 };
  const sortRec = (node: LeafNode) => {
    node.children.sort((a, b) => {
      const pa = priorityRank[a.meta?.priority ?? ""] ?? 9;
      const pb = priorityRank[b.meta?.priority ?? ""] ?? 9;
      if (pa !== pb) return pa - pb;
      return a.segment.localeCompare(b.segment);
    });
    for (const c of node.children) sortRec(c);
  };
  sortRec(root);
  // Domain-level ordering: bootstrap → world → battle → infra → unclassified → rest
  const domainRank: Record<string, number> = {
    bootstrap: 0,
    world: 1,
    battle: 2,
    infra: 3,
    unclassified: 4,
  };
  root.children.sort((a, b) => {
    const ra = domainRank[a.segment] ?? 9;
    const rb = domainRank[b.segment] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.segment.localeCompare(b.segment);
  });
  return root.children;
}

/** Count every test under a node, including nested children. */
export function countTestsDeep(node: LeafNode): number {
  let n = node.tests.length;
  for (const c of node.children) n += countTestsDeep(c);
  return n;
}

/** Walk a tree and return every test. */
export function flattenTests(nodes: LeafNode[]): TestEntry[] {
  const out: TestEntry[] = [];
  const walk = (n: LeafNode) => {
    out.push(...n.tests);
    for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

// --- tier helpers ---

export const TIER_META: Record<RunnerTier, { name: string; short: string; color: string }> = {
  1: { name: "GUT", short: "T1", color: "#a78bfa" },
  2: { name: "Integration", short: "T2", color: "#60a5fa" },
  3: { name: "Playwright", short: "T3", color: "#a7f3d0" },
};

export function filterByTier(tests: TestEntry[], tier: RunnerTier): TestEntry[] {
  return tests.filter((t) => t.tier === tier);
}

// --- slug / id helpers ---

/** Convert a test id like "world.save_load::test_foo" to a URL-safe slug. */
export function testIdToSlug(id: string): string {
  // "::" splits leaf from name; brackets from parametrized IDs are replaced.
  return id
    .replace(/::/g, "--")
    .replace(/[\[\]]/g, "_")
    .replace(/\//g, "_")
    .replace(/\s+/g, "_");
}

/** Find a test in the index by slug. Returns null if missing. */
export function findTestBySlug(index: TestIndex, slug: string): TestEntry | null {
  for (const t of index.tests) {
    if (testIdToSlug(t.id) === slug) return t;
  }
  return null;
}

// --- artifact helpers ---

/** Return the path to the most recent screenshot for a test, or null. */
export function latestScreenshot(test: TestEntry): string | null {
  const list = test.artifacts?.screenshots || [];
  if (list.length === 0) return null;
  // Contract says list is chronological, latest last.
  return list[list.length - 1] ?? null;
}

// --- time helpers ---

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const delta = (then - Date.now()) / 1000; // seconds; negative = past
  const abs = Math.abs(delta);
  if (abs < 60) return RTF.format(Math.round(delta), "second");
  if (abs < 3600) return RTF.format(Math.round(delta / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(delta / 3600), "hour");
  if (abs < 86400 * 30) return RTF.format(Math.round(delta / 86400), "day");
  return new Date(iso).toLocaleDateString();
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

/** Status outcome classification used by the dashboard UI. */
export type StatusClass = "pass" | "fail" | "xfail" | "skip" | "unknown" | "running";

export function statusClass(status: TestStatus): StatusClass {
  switch (status) {
    case "passing":
      return "pass";
    case "failing":
      return "fail";
    case "xfail":
    case "xpass":
      return "xfail";
    case "skipped":
      return "skip";
    case "pending":
    case "unknown":
    default:
      return "unknown";
  }
}
