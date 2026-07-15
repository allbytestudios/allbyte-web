// Types for the `bd` (beads) JSONL export at `.beads/issues.jsonl`.
// Beads is the canonical issue-tracking source going forward; AppC reads
// the JSONL directly (no Arc-side bridge). Schema observed against beads
// 2026-05-16 export — keep optional fields generous so future schema
// additions don't break the parser.

export type BdStatus = "open" | "closed" | string;
export type BdIssueType = "epic" | "bug" | "feature" | "task" | string;

export interface BdIssue {
  _type?: "issue";
  id: string;
  title: string;
  description?: string;
  status: BdStatus;
  /** Lower = higher priority. Observed: 1 = P1, 2 = P2, 3 = P3. */
  priority: number;
  issue_type: BdIssueType;
  owner?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  /** Labels include `milestone:<id>` for milestone grouping. */
  labels?: string[];
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
}

/** Filter helper: just epics, in display order (open before closed, recent first). */
export function epicsOnly(issues: BdIssue[]): BdIssue[] {
  return issues.filter((i) => i.issue_type === "epic");
}

export function isOpen(i: BdIssue): boolean {
  return i.status === "open";
}

export function isClosed(i: BdIssue): boolean {
  return i.status === "closed";
}

export function isNeedsVerify(i: BdIssue): boolean {
  return (i.labels ?? []).includes("needs-verify");
}

export type BeadLane = "completed" | "needs-verify" | "backlog";

// Which owner-facing lane an issue belongs to. needs-verify is checked BEFORE
// the backlog fallback, so an in_progress + needs-verify issue (e.g. k5g6) lands
// in "needs-verify", not "backlog" (per CON_CLAUDE_BEADS_WEBAPP_3LANE.md).
export function laneOf(i: BdIssue): BeadLane {
  if (i.status === "closed") return "completed";
  if (isNeedsVerify(i)) return "needs-verify";
  return "backlog";
}

// Partition live beads ISSUES into the 3 lanes, sorted priority asc then
// updated_at desc within each. `_type !== "issue"` drops the bundled historical
// epics (epic-view only) and is defensive against non-issue records (memory).
export function partitionLanes(issues: BdIssue[]): Record<BeadLane, BdIssue[]> {
  const lanes: Record<BeadLane, BdIssue[]> = { completed: [], "needs-verify": [], backlog: [] };
  for (const i of issues) {
    if (i._type !== "issue") continue;
    lanes[laneOf(i)].push(i);
  }
  const bySort = (a: BdIssue, b: BdIssue) =>
    (a.priority ?? 99) - (b.priority ?? 99) || (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  lanes.completed.sort(bySort);
  lanes["needs-verify"].sort(bySort);
  lanes.backlog.sort(bySort);
  return lanes;
}
