// Fetch + parse the bd JSONL export. In dev, the chroniclesProxy Vite
// middleware serves /test-data/* from the Chronicles repo on disk, so
// `.beads/issues.jsonl` is reachable at `/test-data/.beads/issues.jsonl`.
// In prod, `sync-test-data-watcher.js` copies the same file to
// s3://bucket/test-snapshot/.beads/issues.jsonl and we read it from there.
//
// Pre-Alpha epics shipped before the bd migration, so we also bundle a
// static snapshot (`src/data/historical_epics.json`) and merge it in. Once
// Arc backfills Pre-Alpha into bd, this snapshot can go.

import type { BdIssue } from "./beadsTypes";
import historicalData from "../data/historical_epics.json";

const BASE = import.meta.env.DEV ? "/test-data" : "/test-snapshot";
const ISSUES_PATH = "/.beads/issues.jsonl";

const HISTORICAL_EPICS: BdIssue[] = (historicalData.epics ?? []) as BdIssue[];

export async function fetchBeadsIssues(signal?: AbortSignal): Promise<BdIssue[]> {
  const res = await fetch(`${BASE}${ISSUES_PATH}`, {
    cache: "no-store",
    signal,
  });
  const live: BdIssue[] = [];
  if (res.ok) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        live.push(JSON.parse(t) as BdIssue);
      } catch {
        // Skip malformed lines — JSONL is line-delimited; a partial write
        // shouldn't break the dashboard for the rest.
      }
    }
  }
  // Historical Pre-Alpha epics always merged in; safe to concat because
  // id namespaces never collide (bd uses "ChroniclesOfNesis-<short>",
  // historical uses uppercase semantic ids like "SAVE-LOAD-GUI").
  return [...live, ...HISTORICAL_EPICS];
}

export const BEADS_SSE_PATH = "tickets/.beads/issues.jsonl";

// Note: the chroniclesProxy serves anything under chroniclesRoot, so the
// `tickets/` prefix in SSE_PATH is a path-relative-to-chronicles convention
// matching the rest of the SSE allowlist entries. The actual file lives at
// `<chroniclesRoot>/.beads/issues.jsonl` — there's no `tickets/` directory
// in the path. Hence the slightly weird-looking constant: the SSE event
// key uses the on-disk relative path from chroniclesRoot, which for this
// file is `.beads/issues.jsonl`. Defined below correctly.
