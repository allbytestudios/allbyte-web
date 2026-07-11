// Remote console-log shipper for the DEVELOP build.
//
// The develop build's index.html keeps a `window._consoleLogs` ring buffer. This
// ships it to the /logs endpoint (infrastructure/bug-reports.yaml) every ~12s and
// on tab-hide/pagehide, keyed by a session id (one S3 object per session, latest
// buffer wins). Lets App/Arc read a REAL device's develop console — no USB
// debugging. Session-keyed, no PII beyond the UA already in the buffer.
//
// GATING: the caller only inits this on the develop channel, so public players'
// logs are never shipped.

const LOGS_URL = "https://g5byr6mvm9.execute-api.us-east-1.amazonaws.com/logs";
const SID_KEY = "ab_logship_sid";
const INTERVAL_MS = 12000;

function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SID_KEY);
    if (!id) {
      const raw =
        (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      id = raw.replace(/[^A-Za-z0-9_-]/g, "");
      sessionStorage.setItem(SID_KEY, id);
    }
    return id;
  } catch {
    return "nostore";
  }
}

/**
 * Start shipping the develop console. `getLogs` returns the game's current
 * `_consoleLogs` (or null); `meta` returns per-ship context (version, UA, url).
 * Returns a teardown fn. No-op if LOGS_URL is unset.
 */
export function initConsoleLogShipper(
  getLogs: () => string[] | null,
  meta: () => Record<string, unknown>,
): () => void {
  if (typeof window === "undefined" || !LOGS_URL) return () => {};
  const sid = sessionId();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCount = -1;

  function ship(useBeacon = false): void {
    let logs: string[] | null = null;
    try {
      logs = getLogs();
    } catch {
      logs = null;
    }
    if (!Array.isArray(logs) || logs.length === 0) return;
    // Skip if nothing new since the last poll (except the final pagehide flush).
    if (!useBeacon && logs.length === lastCount) return;
    lastCount = logs.length;
    const m = meta();
    const body = JSON.stringify({
      sessionId: sid,
      version: (m as any).version ?? null,
      logs: logs.slice(-3000),
      meta: m,
    });
    try {
      if (useBeacon && navigator.sendBeacon) {
        // text/plain = CORS-simple, so it survives the tab closing (no preflight).
        navigator.sendBeacon(LOGS_URL, new Blob([body], { type: "text/plain" }));
      } else {
        void fetch(LOGS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
      }
    } catch {
      /* best-effort — never break the page */
    }
  }

  timer = setInterval(() => ship(false), INTERVAL_MS);
  setTimeout(() => ship(false), 4000); // first flush once some logs accumulate
  const onHidden = () => {
    if (document.visibilityState === "hidden") ship(true);
  };
  document.addEventListener("visibilitychange", onHidden);
  const onPageHide = () => ship(true);
  window.addEventListener("pagehide", onPageHide);

  return () => {
    if (timer) clearInterval(timer);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", onPageHide);
  };
}
