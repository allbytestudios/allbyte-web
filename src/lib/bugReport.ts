// In-game bug reports.
//
// The game (iframe) postMessages a report to the /play parent, which enriches it
// with parent-side context and POSTs here. Pairs with infrastructure/bug-reports.yaml
// (a standalone stack): the record + logs + meta land in DynamoDB, the save
// snapshot in S3. Unlike playAnalytics this is NOT prod-gated and does NOT exclude
// the owner — the owner/testers are the primary reporters, and dev testing must work.
//
// Transport: fetch POST (not sendBeacon) — we need the response (reportId / errors)
// and an Authorization header (sendBeacon can't set one). A Bearer JWT is attached
// when the user is logged in so the report carries who filed it; anonymous is fine.

// WriteEndpoint output of the bug-reports CloudFormation stack
// (allbyte-studio-bug-reports, us-east-1). Empty string = disabled (no-op).
const WRITE_URL = "https://g5byr6mvm9.execute-api.us-east-1.amazonaws.com/report";

// Same localStorage key auth.svelte.ts stores the JWT under.
const TOKEN_KEY = "allbyte_token";

export interface BugReportContext {
  scene?: string | null;
  /** Current save state, for repro — sent to S3, so size is not a concern. */
  saveSnapshot?: unknown;
  /** Recent console/error lines from the game side. */
  recentLogs?: string[];
  [key: string]: unknown;
}

export interface BugReportInput {
  text: string;
  category?: string;
  context?: BugReportContext;
}

export interface BugReportResult {
  ok: boolean;
  reportId?: string;
  error?: string;
}

/**
 * Enrich a report with parent-side context and POST it. `extraMeta` is what only
 * the /play parent knows (channel, gameVersion, tier); the rest is derived here.
 * Never throws — returns a result so the caller can ack success/failure to the game.
 */
export async function submitBugReport(
  input: BugReportInput,
  extraMeta: Record<string, unknown> = {},
): Promise<BugReportResult> {
  if (typeof window === "undefined" || !WRITE_URL) return { ok: false, error: "disabled" };
  const text = (input?.text || "").trim();
  if (!text) return { ok: false, error: "empty" };

  const ctx = input.context || {};
  const meta: Record<string, unknown> = {
    url: window.location.href,
    referrer: document.referrer || "",
    userAgent: navigator.userAgent || "",
    language: navigator.language || "",
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    scene: ctx.scene ?? null,
    reportedAt: new Date().toISOString(),
    ...extraMeta,
  };

  const body = JSON.stringify({
    text: text.slice(0, 8000),
    category: (input.category || "other").slice(0, 40),
    recentLogs: Array.isArray(ctx.recentLogs)
      ? ctx.recentLogs.filter((l) => typeof l === "string").slice(0, 300)
      : [],
    // undefined is dropped by JSON.stringify — no snapshot key when absent.
    saveSnapshot: ctx.saveSnapshot,
    meta,
  });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers["Authorization"] = `Bearer ${token}`;
  } catch {
    /* storage blocked — file it anonymously */
  }

  try {
    const resp = await fetch(WRITE_URL, { method: "POST", headers, body });
    if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
    const data = await resp.json().catch(() => ({}) as any);
    return { ok: true, reportId: data.reportId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
