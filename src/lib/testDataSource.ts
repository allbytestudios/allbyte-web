// Dev/prod base URL selector + fetch helpers for the test dashboard.
// - In dev (`import.meta.env.DEV`), fetches go to /test-data/* which is
//   served by the Vite middleware in astro.config.mjs from the Chronicles
//   repo on disk. Live.
// - In prod, fetches go to /test-snapshot/* which is a static snapshot
//   copied into public/test-snapshot/ at build time (phase 2; empty for now).

import type { TestIndex, TestRunStatus } from "./testIndex";
import { assertSupportedSchema } from "./testIndex";
import type { TestingRoadmap } from "./testingRoadmap";
import { assertSupportedRoadmapSchema } from "./testingRoadmap";

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

/**
 * Fetch the testing roadmap. Returns null if the file doesn't exist (roadmap
 * hasn't been emitted yet or the dashboard is running against a dataset that
 * predates it). Any other error throws.
 */
export interface SyncHeartbeat {
  schema_version: number;
  written_at: string;
  started_at: string | null;
  last_sync_at: string | null;
  last_sync_ok: boolean | null;
  last_change_at: string | null;
  consecutive_failures: number;
  host: string;
  pid: number;
}

/**
 * Fetch the watcher heartbeat. Returns null if the file doesn't exist (dev
 * mode or watcher has never run). Any other error throws.
 */
export async function fetchHeartbeat(
  signal?: AbortSignal
): Promise<SyncHeartbeat | null> {
  // In dev the watcher isn't writing to the live middleware path, so skip.
  if (import.meta.env.DEV) return null;
  const res = await fetch(`${TEST_DATA_BASE}/heartbeat.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    return (await res.json()) as SyncHeartbeat;
  } catch {
    return null;
  }
}

import type { TicketsFile, DashboardFile, AgentsFile, EpicsFile, FixtureManifest } from "./ticketTypes";

export async function fetchTickets(signal?: AbortSignal): Promise<TicketsFile | null> {
  const res = await fetch(`${TEST_DATA_BASE}/tickets/tickets.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as TicketsFile;
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardFile | null> {
  const res = await fetch(`${TEST_DATA_BASE}/tickets/dashboard.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as DashboardFile;
}

export async function fetchAgents(signal?: AbortSignal): Promise<AgentsFile | null> {
  const res = await fetch(`${TEST_DATA_BASE}/tickets/agents.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as AgentsFile;
}

export async function fetchEpics(signal?: AbortSignal): Promise<EpicsFile | null> {
  const res = await fetch(`${TEST_DATA_BASE}/tickets/epics.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as EpicsFile;
}

export async function fetchFixtureManifest(signal?: AbortSignal): Promise<FixtureManifest | null> {
  const res = await fetch(`${TEST_DATA_BASE}/test_fixtures/manifest.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as FixtureManifest;
}

export function fixtureUrl(savePath: string): string {
  return `${TEST_DATA_BASE}/${savePath.replace(/^\/+/, "")}`;
}

export async function fetchRoadmap(
  signal?: AbortSignal
): Promise<TestingRoadmap | null> {
  const res = await fetch(`${TEST_DATA_BASE}/test_roadmap.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`test_roadmap.json fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as TestingRoadmap;
  assertSupportedRoadmapSchema(data);
  return data;
}
