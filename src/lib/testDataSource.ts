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

export async function fetchAgentChat(signal?: AbortSignal): Promise<import("./ticketTypes").ChatMessage[]> {
  const res = await fetch(`${TEST_DATA_BASE}/tickets/agent_chat.ndjson`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return [];
  if (!res.ok) return [];
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function fetchAgentActivity(signal?: AbortSignal): Promise<import("./ticketTypes").AgentActivity | null> {
  const res = await fetch(`${TEST_DATA_BASE}/tickets/agent_activity.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return await res.json();
}

export async function submitDecision(decisionId: string, choice: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/decisions/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisionId, choice }),
  });
  if (!res.ok) throw new Error(`Decision submit failed: ${res.status}`);
  return res.json();
}

/** Owner Questions queue — Arc's synthesized "waiting on AllByte" file. */
export async function fetchOwnerQuestions(
  signal?: AbortSignal
): Promise<import("./ticketTypes").OwnerQuestionsFile | null> {
  const res = await fetch(`${TEST_DATA_BASE}/tickets/owner_questions.json`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return await res.json();
}

/**
 * Submit an answer to an owner question. Body shape mirrors OwnerAnswer
 * minus the timestamp/answeredBy fields — the middleware fills those.
 * Exactly one of choice/verified/freeText should be populated based on
 * the question's answerType.
 */
export async function submitOwnerAnswer(answer: {
  questionId: string;
  answerType: import("./ticketTypes").OwnerQuestionAnswerType;
  choice?: string | null;
  verified?: boolean | null;
  issueNote?: string | null;
  freeText?: string | null;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/answers/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(answer),
  });
  if (!res.ok) throw new Error(`Answer submit failed: ${res.status}`);
  return res.json();
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

const API_BASE = "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com";

export interface UserAnalytics {
  totalRegistered: number;
  newThisWeek: number;
  newThisMonth: number;
  byTier: Record<string, number>;
  activeSubscriptions: { initiate: number; hero: number; legend: number };
  oauthUsers: number;
  emailPasswordUsers: number;
  dailyHistory: { date: string; total: number; new: number }[];
}

export async function fetchUserAnalytics(signal?: AbortSignal): Promise<UserAnalytics | null> {
  try {
    // no-store: backend currently sends `cache-control: public, max-age=3600`
    // which caused stale 204s to be served to already-authenticated browsers.
    const res = await fetch(`${API_BASE}/analytics/users`, { signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface BudgetStatus {
  spent: number;
  budget: number;
  pctUsed: number;
  forecast: number;
  dailyRate: number;
  daysRemaining: number;
  daysInMonth: number;
  period: string;
}

export interface SiteTraffic {
  totalRequests7d: number;
  dailyRequests: { date: string; requests: number }[];
}

export async function fetchSiteTraffic(signal?: AbortSignal): Promise<SiteTraffic | null> {
  try {
    const res = await fetch(`${API_BASE}/analytics/traffic`, { signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchBudgetStatus(signal?: AbortSignal): Promise<BudgetStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/analytics/budget`, {
      signal,
      cache: "no-store",
      headers: { Authorization: `Bearer ${localStorage.getItem("allbyte_token") ?? ""}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
