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
// A boot that WORKED but fell back on stored data it couldn't read (an old or
// corrupt save/options file). The game tags each fallback "[COMPAT] <file>
// <reason>" (Nix, develop eb8f9f38); these are the backwards-compatibility
// signals, and they never show up as a failure.
export const COMPAT_REPORT_CATEGORY = "compat";
export const COMPAT_TAG = "[COMPAT]";

const PROD_HOST = "allbyte.studio";
const LOG_LINES = 60;
const HEAD_LINES = 20;
const LOG_LINE_CHARS = 300;
// More than one report per load is noise; more than this per tab session means
// something is looping and the extra copies add nothing.
const SESSION_CAP = 3;
const SESSION_KEY = "ab_boot_reports";

const sentThisPage = new Set<string>();

// Errors thrown by the /play/ page itself (not the game iframe, whose console
// the game already captures). A boot can fail on the site side too, e.g. a bad
// stored value, and those never reach window._consoleLogs.
const pageErrors: string[] = [];
let capturing = false;
export function capturePageErrors(): () => void {
  if (typeof window === "undefined" || capturing) return () => {};
  capturing = true;
  const push = (msg: string) => {
    pageErrors.push(msg.slice(0, LOG_LINE_CHARS));
    if (pageErrors.length > 10) pageErrors.shift();
  };
  const onError = (e: ErrorEvent) => push(`${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`);
  const onRejection = (e: PromiseRejectionEvent) => push(`unhandled rejection: ${String((e.reason as any)?.message ?? e.reason)}`);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    capturing = false;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

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

/**
 * The game's console, trimmed to fit a keepalive request: the first few lines
 * as well as the tail. A failure's earliest message is usually the cause, and
 * a wedged engine can repeat errors until that line falls out of a tail-only
 * window (2026-11-13: the owner saw a JSON error that no report carried).
 */
export function consoleTail(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  const clip = (l: unknown) => String(l).slice(0, LOG_LINE_CHARS);
  if (logs.length <= LOG_LINES) return logs.map(clip);
  const head = logs.slice(0, HEAD_LINES).map(clip);
  const tail = logs.slice(-(LOG_LINES - HEAD_LINES)).map(clip);
  return [...head, `… ${logs.length - LOG_LINES} lines omitted …`, ...tail];
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
  category: string = BOOT_REPORT_CATEGORY,
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
  const all = { bootReason: reason, ...bootEnvironment(), ...meta, pageErrors: pageErrors.join(" | ") };
  for (const [k, v] of Object.entries(all)) {
    flat[k] = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  }
  void submitBugReport(
    {
      text: `[auto] ${category === BOOT_REPORT_CATEGORY ? "boot failure" : category}: ${reason} — ${detail}`,
      category,
      context: { recentLogs: logs },
    },
    flat,
    { keepalive: true },
  );
}
