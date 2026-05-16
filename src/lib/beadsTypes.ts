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
