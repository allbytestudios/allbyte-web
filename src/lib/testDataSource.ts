// Dev/prod base URL selector + fetch helpers for the test dashboard.
// - In dev (`import.meta.env.DEV`), fetches go to /test-data/* which is
//   served by the Vite middleware in astro.config.mjs from the Chronicles
//   repo on disk. Live.
// - In prod, fetches go to /test-snapshot/* which is a static snapshot
//   copied into public/test-snapshot/ at build time (phase 2; empty for now).

import type { TestIndex, TestRunStatus } from "./testIndex";
import { assertSupportedSchema } from "./testIndex";

export const TEST_DATA_BASE = import.meta.env.DEV ? "/test-data" : "/test-snapshot";

export function artifactUrl(relPath: string): string {
  const clean = relPath.replace(/^\/+/, "");
  return `${TEST_DATA_BASE}/${clean}`;
}

export async function fetchIndex(signal?: AbortSignal): Promise<TestIndex> {
  const res = await fetch(`${TEST_DATA_BASE}/test_index.json`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `test_index.json fetch failed: ${res.status}. In dev, ensure CHRONICLES_DIR points at the Chronicles repo. In prod, ensure public/test-snapshot/ was populated at build time.`
    );
  }
  const data = (await res.json()) as TestIndex;
  assertSupportedSchema(data);
  return data;
}

/**
 * Fetch the live run status. Returns null if the file doesn't exist
 * (snapshot-only mode or CON's plugin hasn't landed yet). Any other error
 * throws.
 */
export async function fetchStatus(signal?: AbortSignal): Promise<TestRunStatus | null> {
  const res = await fetch(`${TEST_DATA_BASE}/test_results/test_run_status.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`test_run_status.json fetch failed: ${res.status}`);
  }
  return (await res.json()) as TestRunStatus;
}
