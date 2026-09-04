// Real-user performance reporting.
//
// WHY THIS EXISTS: for a long stretch the owner reported a stalling /play/ load
// screen while every measurement taken on the dev machine came back clean —
// headless Chromium on a desktop is not a phone on a home connection, and the
// gap cost hours of guessing. This reports what actually happened in a real
// browser, so a report becomes numbers instead of a description.
//
// It also outlives the immediate bug: once shipped, every visitor contributes,
// so "is the site fast for people who aren't us" stops being unanswerable.
//
// PRIVACY POSTURE — identical to the play funnel (see /privacy): a
// session-scoped RANDOM id that dies with the tab, a coarse device class, the
// referrer HOST only. No account id, no IP handling here, nothing persistent or
// cross-site. Timings and counters only.
//
// Transport is navigator.sendBeacon with a text/plain body: a CORS "simple"
// request, so no preflight, and it survives the page being closed.

const WRITE_URL = "https://pdtoj70foi.execute-api.us-east-1.amazonaws.com/play";
const PROD_HOST = "allbyte.studio";
const SID_KEY = "ab_play_sid";
const OWNER_KEY = "ab_play_owner";
/** Per-device opt-in so the owner's own phone can report perf (see perfOptIn). */
const PERF_OPTIN_KEY = "ab_perf_optin";
/** Long tasks shorter than this are normal scheduling, not a stall. */
const LONG_TASK_MS = 50;
/** Give slow boots time to finish before reporting; also flushed on pagehide. */
const REPORT_AFTER_MS = 20_000;

type Marks = Record<string, number>;

let marks: Marks = {};
let longTaskCount = 0;
let longTaskTotal = 0;
let longTaskMax = 0;
let longTaskMaxAt = 0;
let lcp = 0;
let fpsMin = 0;
let fpsMax = 0;
let fpsSamples = 0;
let sent = false;

/**
 * Record a named moment, in ms since navigation start.
 *
 * Call this from anywhere for anything worth explaining a slow load with. The
 * loader uses it for worker-created / studio-end / first-card / reveal, which
 * are precisely the marks that were missing while we were guessing.
 */
export function perfMark(name: string, at?: number): void {
  try {
    if (marks[name] === undefined) {
      marks[name] = Math.round(at ?? performance.now());
    }
  } catch {
    /* never break the page for telemetry */
  }
}

/** Feed the load-screen worker's own frame rate in (it is the honest one — a
 *  main-thread counter would just be measuring the block). */
export function perfFps(fps: number): void {
  if (!Number.isFinite(fps) || fps <= 0) return;
  fpsSamples++;
  if (!fpsMin || fps < fpsMin) fpsMin = fps;
  if (fps > fpsMax) fpsMax = fps;
}

function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SID_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(SID_KEY, id);
    }
    return id;
  } catch {
    return "nostore";
  }
}

function deviceClass(): string {
  try {
    const ua = (navigator.userAgent || "").toLowerCase();
    let os = "Other";
    if (/iphone|ipad|ipod/.test(ua)) os = "iOS";
    else if (ua.includes("android")) os = "Android";
    else if (ua.includes("windows")) os = "Windows";
    else if (ua.includes("mac os") || ua.includes("macintosh")) os = "macOS";
    else if (ua.includes("linux")) os = "Linux";
    let br = "Other";
    if (ua.includes("edg")) br = "Edge";
    else if (ua.includes("firefox") || ua.includes("fxios")) br = "Firefox";
    else if (ua.includes("crios") || ua.includes("chrome")) br = "Chrome";
    else if (ua.includes("safari")) br = "Safari";
    return `${os} ${br}`;
  } catch {
    return "Other Other";
  }
}

function referrerHost(): string {
  try {
    if (!document.referrer) return "direct";
    const h = new URL(document.referrer).hostname.replace(/^www\./, "");
    return h.endsWith(PROD_HOST) ? "internal" : h;
  } catch {
    return "direct";
  }
}

/**
 * Owner opt-IN, per device: visit any page with `?perf=1` to make this device
 * report, `?perf=0` to stop.
 *
 * The play funnel excludes the owner because it measures acquisition and
 * behaviour, where the owner's own visits are noise. Performance is the
 * opposite: with almost no outside traffic the owner's phone is the most
 * valuable data point there is, and it is the device the problems actually
 * show up on. So the two gates are deliberately separate — opting in here does
 * not put the owner back into the funnel.
 *
 * Opted-in reports carry own:1 so they can be filtered out later, once real
 * traffic makes the distinction matter. Silently mixing them would poison the
 * baseline exactly when it starts being worth something.
 */
function perfOptIn(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("perf");
    if (q === "1") {
      localStorage.setItem(PERF_OPTIN_KEY, "1");
      console.log("[perf] reporting ENABLED on this device (?perf=0 to stop)");
    } else if (q === "0") {
      localStorage.removeItem(PERF_OPTIN_KEY);
      console.log("[perf] reporting disabled on this device");
    }
    return localStorage.getItem(PERF_OPTIN_KEY) === "1";
  } catch {
    // Private mode: honour the URL for this page view even though it cannot
    // persist, so a one-off diagnostic still works.
    try {
      return new URLSearchParams(location.search).get("perf") === "1";
    } catch {
      return false;
    }
  }
}

/** Excluded from reporting: automation always, and the owner's own devices
 *  unless they have explicitly opted in above. */
function excluded(): boolean {
  try {
    // Automation is never a useful data point, opt-in or not.
    if ((navigator as any).webdriver === true) return true;
    if (perfOptIn()) return false;
    if (localStorage.getItem(OWNER_KEY) === "1") return true;
  } catch {
    /* storage unavailable — fall through */
  }
  return false;
}

/**
 * Everything worth knowing about how this load went, as one flat object.
 *
 * Deliberately compact: it rides in a single beacon field with a size cap, and
 * a metric nobody reads is just payload. Every entry here earned its place by
 * being something we actually needed and did not have.
 */
function collect(): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav) {
      out.ttfb = Math.round(nav.responseStart);
      out.dcl = Math.round(nav.domContentLoadedEventEnd);
      out.load = Math.round(nav.loadEventEnd);
      out.nav = nav.type; // navigate | reload | back_forward
      // Cold vs warm matters more than expected: a warm cache serves the WASM
      // instantly and compiles it as one unbroken block, so repeat visits are
      // the HARDER case, not the easier one.
      out.xfer = nav.transferSize;
    }
    for (const p of performance.getEntriesByType("paint")) {
      if (p.name === "first-contentful-paint") out.fcp = Math.round(p.startTime);
    }
    if (lcp) out.lcp = Math.round(lcp);

    // The headline numbers for a stalled load screen.
    out.ltN = longTaskCount;
    out.ltTotal = Math.round(longTaskTotal);
    out.ltMax = Math.round(longTaskMax);
    out.ltMaxAt = Math.round(longTaskMaxAt);

    if (fpsSamples) {
      out.fpsMin = fpsMin;
      out.fpsMax = fpsMax;
      out.fpsN = fpsSamples;
    }
    for (const [k, v] of Object.entries(marks)) out[`m_${k}`] = v;

    out.vw = window.innerWidth;
    out.vh = window.innerHeight;
    out.dpr = Math.round((window.devicePixelRatio || 1) * 10) / 10;
    out.hw = (navigator as any).hardwareConcurrency || 0;
    const c = (navigator as any).connection;
    if (c?.effectiveType) out.net = String(c.effectiveType).slice(0, 8);
    if ((navigator as any).deviceMemory) out.mem = (navigator as any).deviceMemory;
    out.sw = navigator.serviceWorker?.controller ? 1 : 0;
    // Marks this as an owner device reporting by opt-in, not organic traffic.
    if (perfOptIn()) out.own = 1;
  } catch {
    /* partial data is still useful */
  }
  return out;
}

function send(): void {
  if (sent) return;
  sent = true;
  try {
    const body = JSON.stringify({
      sid: sessionId(),
      ev: "perf",
      path: location.pathname.slice(0, 60),
      ref: referrerHost(),
      dev: deviceClass(),
      // One JSON blob rather than a column each: the shape changes as we learn
      // what matters, and the backend should not need a deploy to keep up.
      m: JSON.stringify(collect()).slice(0, 1400),
    });
    navigator.sendBeacon(WRITE_URL, new Blob([body], { type: "text/plain" }));
  } catch {
    /* best effort */
  }
}

/**
 * Start collecting. Safe to call on every page; no-op off the prod host, for
 * automation, and for the owner's marked devices.
 *
 * Reports once — whichever comes first of a settle timer or the page going
 * away — because a load that never "finishes" is exactly the one worth hearing
 * about.
 */
export function initPerfBeacon(): () => void {
  if (typeof window === "undefined") return () => {};
  const host = location.hostname;
  if (host !== PROD_HOST && host !== `www.${PROD_HOST}`) return () => {};
  if (excluded()) return () => {};

  const obs: PerformanceObserver[] = [];
  const observe = (type: string, cb: (e: PerformanceEntry) => void) => {
    try {
      const o = new PerformanceObserver((l) => l.getEntries().forEach(cb));
      o.observe({ type, buffered: true } as PerformanceObserverInit);
      obs.push(o);
    } catch {
      /* unsupported in this browser — that metric is simply absent */
    }
  };

  observe("longtask", (e) => {
    if (e.duration < LONG_TASK_MS) return;
    longTaskCount++;
    longTaskTotal += e.duration;
    if (e.duration > longTaskMax) {
      longTaskMax = e.duration;
      longTaskMaxAt = e.startTime;
    }
  });
  observe("largest-contentful-paint", (e) => {
    lcp = e.startTime;
  });

  const timer = setTimeout(send, REPORT_AFTER_MS);
  const onHide = () => {
    if (document.visibilityState === "hidden") send();
  };
  window.addEventListener("pagehide", send);
  document.addEventListener("visibilitychange", onHide);

  return () => {
    clearTimeout(timer);
    window.removeEventListener("pagehide", send);
    document.removeEventListener("visibilitychange", onHide);
    obs.forEach((o) => o.disconnect());
  };
}
