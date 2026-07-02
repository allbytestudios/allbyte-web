// Anonymous play-depth funnel beacon.
//
// Fires lightweight, no-PII beacons from /play/ so we can see how far players
// actually get (arrive → game boots → which scenes/zones they reach → time
// played). Pairs with infrastructure/play-analytics.yaml (a standalone stack).
//
// Privacy posture (see /privacy): a session-scoped RANDOM id (sessionStorage,
// gone when the tab closes — not a tracking cookie), the scene names reached,
// seconds played, and the referrer HOST only (e.g. "reddit.com", never the full
// URL). No account id, no IP handling here, nothing cross-site or persistent.
//
// Transport: navigator.sendBeacon with a text/plain body — a CORS "simple"
// request, so no preflight and it survives the tab closing (for the final
// "end" event). If WRITE_URL is unset the whole module is a silent no-op, so
// it's safe to ship before the backend stack is deployed.

// WriteEndpoint output of the play-analytics CloudFormation stack
// (allbyte-studio-play-analytics, us-east-1). Empty string = disabled (no-op).
const WRITE_URL = "https://pdtoj70foi.execute-api.us-east-1.amazonaws.com/play";

// Only record real prod sessions — keeps localhost/dev noise out of the funnel.
const PROD_HOST = "allbyte.studio";
const POLL_MS = 4000;
const SID_KEY = "ab_play_sid";
const OWNER_KEY = "ab_play_owner";

/**
 * True for clients we exclude from the funnel — keeps bots and the owner's own
 * playtesting out of the data:
 *  - Automation: `navigator.webdriver` is true for headless/automated browsers
 *    (crawlers that run JS, and our own Playwright E2E/smoke). Real browsers
 *    report false. This is what removes the "sessions but 0% boot" bot classes.
 *  - Owner devices: visiting any /play URL with `?owner=1` persists a marker in
 *    localStorage; that device is excluded thereafter. Lets the owner mark each
 *    machine/phone they test on without any account coupling (the funnel is
 *    anonymous by design).
 */
function isExcludedClient(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("owner") === "1") {
      try {
        localStorage.setItem(OWNER_KEY, "1");
      } catch {
        /* private mode — marker won't persist, but this session is still excluded */
      }
    }
    if (localStorage.getItem(OWNER_KEY) === "1") return true;
  } catch {
    /* storage unavailable — fall through to the webdriver check */
  }
  try {
    if ((navigator as any).webdriver === true) return true;
  } catch {
    /* ignore */
  }
  return false;
}

type Ev = "open" | "scene" | "end";

/**
 * Snapshot of the game's same-origin `window.gameState` fields the funnel cares
 * about. All confirmed present in the PUBLIC build (Arc, 2026-06-25):
 * `gameState.scene` (current scene node name), `inBattle` (combat is an overlay,
 * NOT a scene), `lastTriggeredEventId` (story progress 1→14), `isMoving`.
 */
export interface PlayState {
  scene?: string | null;
  inBattle?: boolean;
  event?: number | string | null;
  moving?: boolean;
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

function referrerHost(): string {
  try {
    if (!document.referrer) return "direct";
    const h = new URL(document.referrer).hostname.replace(/^www\./, "");
    // Same-site referrals aren't a traffic source — collapse to "internal".
    return h.endsWith(PROD_HOST) ? "internal" : h;
  } catch {
    return "direct";
  }
}

// Coarse "OS Browser" class from the UA — no PII, just a bucket (e.g.
// "iOS Safari", "Android Chrome", "Windows Firefox"). Lets the funnel show
// device mix per stage without collecting the raw user-agent. Order matters:
// Edge UAs contain "Chrome", and Chrome UAs contain "Safari".
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

/**
 * Start the funnel beacon. `stateGetter` returns a snapshot of the game's
 * current state (or null if not booted yet). Returns a teardown fn. No-op
 * unless on the prod host and WRITE_URL is configured.
 *
 * Funnel "stages" are recorded as distinct `scene` events, deduped per session:
 * location scenes use their raw name (e.g. "MainSquare"); progression
 * milestones are namespaced "m:" so the dashboard can split them out
 * ("m:moved", "m:combat", "m:event_<id>"). This keeps the backend schema
 * unchanged while giving both a location funnel and a milestone funnel.
 */
export function initPlayAnalytics(stateGetter: () => PlayState | null): () => void {
  // Accept both the apex and the www alias: www.allbyte.studio serves /play
  // directly (no redirect to apex), so gating on the bare apex silently dropped
  // every www play from the funnel while CloudFront still logged the serve.
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const onProd = host === PROD_HOST || host === `www.${PROD_HOST}`;
  if (typeof window === "undefined" || !WRITE_URL || !onProd || isExcludedClient()) {
    return () => {};
  }

  const sid = sessionId();
  const ref = referrerHost();
  const dev = deviceClass();
  const startTs = Date.now();
  const seen = new Set<string>();
  let lastScene = "";
  let ended = false;
  let poller: ReturnType<typeof setInterval> | null = null;

  const elapsed = () => Math.round((Date.now() - startTs) / 1000);

  function send(ev: Ev, scene: string): void {
    try {
      const body = JSON.stringify({ sid, ev, scene, dur: elapsed(), ref, dev });
      navigator.sendBeacon(WRITE_URL, new Blob([body], { type: "text/plain" }));
    } catch {
      /* best-effort; never break the page */
    }
  }

  // Record a funnel stage once per session.
  function stage(token: string): void {
    if (!token || seen.has(token)) return;
    seen.add(token);
    send("scene", token);
  }

  // Arrival — counts /play loads even if the engine never boots (boot-rate).
  send("open", "");

  function tick(): void {
    let st: PlayState | null = null;
    try {
      st = stateGetter();
    } catch {
      st = null;
    }
    if (!st) return;
    if (st.scene) {
      lastScene = st.scene; // furthest location scene, sent on "end"
      stage(st.scene);
    }
    if (st.moving) stage("m:moved");
    if (st.inBattle) stage("m:combat");
    if (st.event != null && st.event !== 0 && st.event !== "") {
      stage(`m:event_${st.event}`);
    }
  }
  poller = setInterval(tick, POLL_MS);
  tick();

  function end(): void {
    if (ended) return;
    ended = true;
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
    send("end", lastScene);
  }

  // pagehide is the reliable "leaving" signal (covers tab close, navigation,
  // and bfcache on mobile). visibilitychange→hidden is the mobile backstop.
  window.addEventListener("pagehide", end);
  const onHidden = () => {
    if (document.visibilityState === "hidden") end();
  };
  document.addEventListener("visibilitychange", onHidden);

  return () => {
    if (poller) clearInterval(poller);
    window.removeEventListener("pagehide", end);
    document.removeEventListener("visibilitychange", onHidden);
  };
}
