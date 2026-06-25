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
