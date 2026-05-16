// Fetch + parse the bd JSONL export. In dev, the chroniclesProxy Vite
// middleware serves /test-data/* from the Chronicles repo on disk, so
// `.beads/issues.jsonl` is reachable at `/test-data/.beads/issues.jsonl`.
// In prod, `sync-test-data-watcher.js` copies the same file to
// s3://bucket/test-snapshot/.beads/issues.jsonl and we read it from there.

import type { BdIssue } from "./beadsTypes";

const BASE = import.meta.env.DEV ? "/test-data" : "/test-snapshot";
const ISSUES_PATH = "/.beads/issues.jsonl";

export async function fetchBeadsIssues(signal?: AbortSignal): Promise<BdIssue[]> {
  const res = await fetch(`${BASE}${ISSUES_PATH}`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return [];
  if (!res.ok) return [];
  const text = await res.text();
  if (!text.trim()) return [];
  const out: BdIssue[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as BdIssue);
    } catch {
      // Skip malformed lines — JSONL is line-delimited; a partial write
      // shouldn't break the dashboard for the rest.
    }
  }
  return out;
}

export const BEADS_SSE_PATH = "tickets/.beads/issues.jsonl";

// Note: the chroniclesProxy serves anything under chroniclesRoot, so the
// `tickets/` prefix in SSE_PATH is a path-relative-to-chronicles convention
// matching the rest of the SSE allowlist entries. The actual file lives at
// `<chroniclesRoot>/.beads/issues.jsonl` — there's no `tickets/` directory
// in the path. Hence the slightly weird-looking constant: the SSE event
// key uses the on-disk relative path from chroniclesRoot, which for this
// file is `.beads/issues.jsonl`. Defined below correctly.
