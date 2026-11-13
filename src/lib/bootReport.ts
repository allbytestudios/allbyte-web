// Automatic boot-failure reports from /play/.
//
// The startup beacons (playAnalytics) say WHERE a session stopped, but a load
// that wedges at the loader looks exactly like a player who closed the tab. The
// boot watchdog already knows the difference, so when it trips (or the player
// gives up mid-load) we file an anonymous report with the environment and the
// game's console tail. It reuses the bug-report pipeline as
// category "boot_failure", so it needs no backend of its own and lands in the
// /test/bug-reports/ triage view.
//
// Seen 2026-11-13: the owner's Linux desktop sat at 48% on v1.0.2924 while
// every clean browser we could launch booted fine. That machine had nothing to
// tell us, which is why this exists.
//
// Privacy: no account data, no save contents. Console lines can carry scene
// names and engine messages; they are capped in count and length. The GPU is
// reported as vendor only (not the full renderer string).

import { submitBugReport } from "./bugReport";

export const BOOT_REPORT_CATEGORY = "boot_failure";

const PROD_HOST = "allbyte.studio";
const LOG_LINES = 60;
const LOG_LINE_CHARS = 300;
// More than one report per load is noise; more than this per tab session means
// something is looping and the extra copies add nothing.
const SESSION_CAP = 3;
const SESSION_KEY = "ab_boot_reports";

const sentThisPage = new Set<string>();

/** Environment facts that decide whether a Godot web build can boot here. */
export function bootEnvironment(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  try {
    env.crossOriginIsolated = !!window.crossOriginIsolated;
    env.swControlled = !!navigator.serviceWorker?.controller;
    env.hardwareConcurrency = navigator.hardwareConcurrency ?? null;
    env.deviceMemory = (navigator as any).deviceMemory ?? null;
    env.platform = (navigator as any).userAgentData?.platform ?? navigator.platform ?? "";
    env.screen = `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}`;
  } catch {
    /* partial env is still worth sending */
  }
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    env.webgl2 = !!gl;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      env.gpuVendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)).slice(0, 80) : "masked";
      env.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    env.webgl2 = "error";
  }
  return env;
}

/** Last lines of the game's console, trimmed to fit a keepalive request. */
export function consoleTail(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  return logs.slice(-LOG_LINES).map((l) => String(l).slice(0, LOG_LINE_CHARS));
}

/**
 * File one boot report. Fire-and-forget: never throws, never blocks the heal.
 * `reason` is a short stable key (it also dedupes within the page load).
 */
export function sendBootReport(
  reason: string,
  detail: string,
  logs: string[],
  meta: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  const host = window.location.hostname;
  if (host !== PROD_HOST && host !== `www.${PROD_HOST}`) return;
  if (sentThisPage.has(reason)) return;
  sentThisPage.add(reason);
  try {
    const n = Number(sessionStorage.getItem(SESSION_KEY) || "0");
    if (n >= SESSION_CAP) return;
    sessionStorage.setItem(SESSION_KEY, String(n + 1));
  } catch {
    /* storage blocked — the per-page dedupe still applies */
  }
  // Every value goes as a string: the write Lambda parses with plain
  // json.loads and keeps non-string meta as-is, and DynamoDB rejects Python
  // floats (deviceMemory 0.5, a fractional pixel ratio), which would drop the
  // whole report.
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries({ bootReason: reason, ...bootEnvironment(), ...meta })) {
    flat[k] = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  }
  void submitBugReport(
    {
      text: `[auto] boot failure: ${reason} — ${detail}`,
      category: BOOT_REPORT_CATEGORY,
      context: { recentLogs: logs },
    },
    flat,
    { keepalive: true },
  );
}
