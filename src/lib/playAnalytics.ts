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

// Set to the WriteEndpoint output of the play-analytics CloudFormation stack
// after deploy. Empty string = disabled (no-op).
const WRITE_URL = "";

// Only record real prod sessions — keeps localhost/dev noise out of the funnel.
const PROD_HOST = "allbyte.studio";
const POLL_MS = 4000;
const SID_KEY = "ab_play_sid";

type Ev = "open" | "scene" | "end";

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

/**
 * Start the funnel beacon. `sceneGetter` returns the game's current scene name
 * (or null if not booted yet). Returns a teardown fn. No-op unless on the prod
 * host and WRITE_URL is configured.
 */
export function initPlayAnalytics(sceneGetter: () => string | null): () => void {
  if (
    typeof window === "undefined" ||
    !WRITE_URL ||
    window.location.hostname !== PROD_HOST
  ) {
    return () => {};
  }

  const sid = sessionId();
  const ref = referrerHost();
  const startTs = Date.now();
  const seen = new Set<string>();
  let lastScene = "";
  let ended = false;
  let poller: ReturnType<typeof setInterval> | null = null;

  const elapsed = () => Math.round((Date.now() - startTs) / 1000);

  function send(ev: Ev, scene: string): void {
    try {
      const body = JSON.stringify({ sid, ev, scene, dur: elapsed(), ref });
      navigator.sendBeacon(WRITE_URL, new Blob([body], { type: "text/plain" }));
    } catch {
      /* best-effort; never break the page */
    }
  }

  // Arrival — counts /play loads even if the engine never boots (boot-rate).
  send("open", "");

  function tick(): void {
    let scene: string | null = null;
    try {
      scene = sceneGetter();
    } catch {
      scene = null;
    }
    if (scene && !seen.has(scene)) {
      seen.add(scene);
      lastScene = scene;
      send("scene", scene);
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
