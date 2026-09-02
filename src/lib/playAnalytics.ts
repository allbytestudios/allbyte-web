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
import { auth } from "./auth.svelte";

// WriteEndpoint output (see below)
const WRITE_URL = "https://pdtoj70foi.execute-api.us-east-1.amazonaws.com/play";

// Only record real prod sessions — keeps localhost/dev noise out of the funnel.
const PROD_HOST = "allbyte.studio";
const POLL_MS = 4000;
const SID_KEY = "ab_play_sid";
const OWNER_KEY = "ab_play_owner";
// Set once this browser has completed a boot to Title — lets a later session
// report warm-vs-cold launch (§7 "cache / return state") without any tracking
// id: it's a single local boolean, never sent as an identifier.
const WARM_KEY = "ab_play_warm";
// Longest we hold the arrival beacon waiting on /auth/me before recording anyway.
const AUTH_WAIT_MS = 3000;

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
/** True when the auth store currently reports an admin. Local read only. */
function isAdminNow(): boolean {
  try {
    return String(auth.currentUser?.tier || "").toLowerCase() === "admin";
  } catch {
    return false;
  }
}

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
    // Logged-in admin = the owner, on ANY device, with nothing to remember.
    // `?owner=1` only ever tagged the one browser you happened to type it in,
    // which is how the owner's phone ended up in the funnel (owner 2026-08-07).
    // Reading tier locally sends nothing: no account id leaves the page, the
    // beacon body is unchanged, and we only use it to decide NOT to send.
    // Tag the device too, so subsequent loads short-circuit before auth resolves.
    if (isAdminNow()) {
      try { localStorage.setItem(OWNER_KEY, "1"); } catch { /* private mode */ }
      return true;
    }
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
  /**
   * `gameState.newGameStarted` — set true (and sticky) the moment the player
   * actually presses New Game. Arc added this field specifically for this
   * funnel (TestBridge.gd FUNNEL-SIGNAL, 2026-06-26); it's what separates
   * "never even tried to start" from "started, then lost to the pack download".
   */
  newGame?: boolean;
  /** `gameState.inDialogue` — talked to someone; the first real interaction. */
  dialogue?: boolean;
  /**
   * The game's `allbyte_touch_accept` fired — a mobile tap registered as
   * ui_accept (tap-anywhere-to-confirm, added in the touch fix). Recorded as
   * "m:touch" so the funnel can separate "tapped to start" from "actually
   * started" (m:newgame): taps-without-newgame is the signature of the tap path
   * being broken, which is exactly the mobile drop-off we're chasing.
   */
  touch?: boolean;
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

// --- §6 startup instrumentation -------------------------------------------
// The plan's §6 point: the old aggregate funnel ("opened play → past title →
// moved") cannot separate a TECHNICAL failure from a voluntary bounce, because
// both look identical — the session simply stops emitting. §6.1 fixes that with
// an explicit ordered event sequence; §6.3 then classifies a session by the
// furthest event it reached (see STARTUP_SEQ order below).
//
// Wire format: each startup event rides the EXISTING "scene" event as a token
// namespaced `s:` — same trick the milestone funnel uses with `m:`, so the
// backend schema needs no new event type. Two rules make this safe:
//   - the token stays CLEAN (no interpolated timing), so it aggregates;
//   - timing goes in a separate `ms` field, NEVER in `dur`. The reader does
//     `dur = max(dur, ...)` per session as "seconds played", so putting
//     milliseconds there would report a 30s boot as 30,000 seconds.
export const STARTUP_SEQ = [
  "play_page_open",
  "boot_shell_visible",
  "game_download_start",
  "game_download_complete",
  "engine_init_start",
  "engine_init_complete",
  "title_rendered",
  "title_interactive",
  "first_input",
  "new_game_confirmed",
  "continue_confirmed",
  "first_world_scene_ready",
  "first_player_move",
] as const;

export type StartupEvent = (typeof STARTUP_SEQ)[number];

// Set once initPlayAnalytics has decided this client is recordable. Null means
// "not recording" (SSR, dev host, owner/bot, or auth still settling) — marks
// that arrive first are buffered below and flushed on init.
let emitStartup: ((ev: StartupEvent) => void) | null = null;
let pendingMarks: StartupEvent[] = [];

/**
 * Record a §6.1 startup event. Safe to call from anywhere at any time — before
 * init (buffered), twice (deduped downstream), or on a client we don't record
 * (dropped). Callers never need to know whether analytics is live.
 *
 * Timing is NOT passed in: every mark stamps `performance.now()` at the moment
 * it fires, which is already "ms since navigation start" — exactly the origin
 * §6.2 asks durations to be measured from.
 */
export function markStartup(ev: StartupEvent): void {
  if (emitStartup) {
    emitStartup(ev);
    return;
  }
  // Cap the buffer: if analytics never initialises we must not grow forever.
  if (pendingMarks.length < STARTUP_SEQ.length * 2) pendingMarks.push(ev);
}

/**
 * §7 acquisition routing. Answers "does a homepage-qualified visitor behave
 * differently from someone handed an explicitly labelled direct-game link?"
 *
 * Resolution order, most specific first:
 *  1. `?ref=` on THIS url — a marketing link that points straight at /play/.
 *  2. The tab's stored ref, captured by BaseLayout on the first page view. This
 *     is the common case: the link lands on / and the visitor clicks through,
 *     which drops the query string long before the funnel ever runs.
 *  3. `?src=` — the original spelling, kept so older links keep resolving.
 *  4. Referrer inference.
 */
function launchContext(): string {
  const tidy = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.\-]/g, "").slice(0, 40);
  try {
    const p = new URLSearchParams(window.location.search);
    const direct = p.get("ref");
    if (direct) return tidy(direct) || "unknown";
    try {
      const held = sessionStorage.getItem("ab_ref");
      if (held) return tidy(held) || "unknown";
    } catch {
      /* storage unavailable — fall through to referrer inference */
    }
    const q = p.get("src");
    if (q) return tidy(q) || "unknown";
    const r = referrerHost();
    if (r === "direct") return "bookmark_or_direct";
    if (r === "internal") return "homepage_cta";
    if (r.includes("reddit")) return "reddit_direct_play";
    return "external_referral";
  } catch {
    return "unknown";
  }
}

/**
 * §7 session metadata, packed into ONE short string rather than a column per
 * field — keeps the beacon a CORS-simple request and the table schema flat.
 * Deliberately coarse: a viewport bucket and a warm/cold flag are enough to
 * segment startup failures without becoming a fingerprint.
 *
 * Format is `k:v/k:v` — NOT the more obvious `k=v;k=v`, because the write
 * Lambda sanitises every string field through SAFE (`[^A-Za-z0-9_./:\- ]`) and
 * would silently strip `=` and `;`, leaving one unparseable run of characters.
 * `:` and `/` survive that filter, so the separators must be those.
 */
function sessionMeta(): string {
  const bits: string[] = [];
  try {
    bits.push(`vp:${window.innerWidth}x${window.innerHeight}`);
    bits.push(`dpr:${Math.round((window.devicePixelRatio || 1) * 10) / 10}`);
    bits.push(`touch:${navigator.maxTouchPoints > 0 ? 1 : 0}`);
    bits.push(`or:${window.innerWidth >= window.innerHeight ? "l" : "p"}`);
    // Cold vs warm launch: whether this browser has completed a /play/ boot
    // before. Distinguishes "slow because first download" from "slow anyway".
    let warm = 0;
    try {
      warm = localStorage.getItem(WARM_KEY) ? 1 : 0;
    } catch {
      /* private mode — reports cold, which is the safe assumption */
    }
    bits.push(`warm:${warm}`);
    // Only where the browser actually provides it (§7 says don't assume).
    const c = (navigator as any).connection;
    if (c?.effectiveType) bits.push(`net:${String(c.effectiveType).slice(0, 8)}`);
  } catch {
    /* best-effort */
  }
  return bits.join("/").slice(0, 120);
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

  // A logged-in visitor's TIER isn't known until /auth/me resolves, which is
  // after this runs — so an admin would still fire the arrival beacon before we
  // could tell it was the owner. When a token is present but auth hasn't
  // settled, wait for it and then re-enter (by which point isExcludedClient()
  // can see the admin and self-tag the device). Anonymous visitors — nearly all
  // real traffic — never wait, so bounce timing is unaffected.
  let hasToken = false;
  try {
    hasToken = !!localStorage.getItem("allbyte_token");
  } catch {
    /* storage unavailable — treat as anonymous */
  }
  if (hasToken && !auth.authReady) {
    let cancelled = false;
    let inner: (() => void) | null = null;
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cancelled) {
        clearInterval(iv);
        return;
      }
      // Bounded: a dead/slow auth API must not silently drop the session.
      if (auth.authReady || Date.now() - t0 > AUTH_WAIT_MS) {
        clearInterval(iv);
        if (!cancelled) inner = initPlayAnalytics(stateGetter);
      }
    }, 50);
    return () => {
      cancelled = true;
      clearInterval(iv);
      if (inner) inner();
    };
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

  function send(ev: Ev, scene: string, extra?: Record<string, unknown>): void {
    try {
      const body = JSON.stringify({ sid, ev, scene, dur: elapsed(), ref, dev, ...extra });
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

  // §6.1 startup event. `ms` is time since navigation start, which is the
  // origin every §6.2 duration is measured from — so the reader derives all of
  // them by subtracting two marks, and we never send a duration per se.
  function startup(evName: StartupEvent): void {
    const token = `s:${evName}`;
    if (seen.has(token)) return; // each startup event is once-per-session
    seen.add(token);
    send("scene", token, { ms: Math.round(performance.now()) });
    // Reaching an interactive title is what makes the NEXT visit a warm launch.
    if (evName === "title_interactive") {
      try {
        localStorage.setItem(WARM_KEY, "1");
      } catch {
        /* private mode — next launch just reports cold */
      }
    }
  }

  emitStartup = startup;

  // Arrival — counts /play loads even if the engine never boots (boot-rate).
  // `meta` + `ctx` ride the open beacon only: they're per-session constants,
  // so repeating them on every stage would be pure payload.
  send("open", "", { meta: sessionMeta(), ctx: launchContext() });
  startup("play_page_open");

  // Anything marked before we were ready to record (the boot shell paints
  // before onMount in a fast load, and an admin check can defer init by up to
  // AUTH_WAIT_MS) is replayed now, in the order it happened.
  const replay = pendingMarks;
  pendingMarks = [];
  for (const m of replay) startup(m);

  function tick(): void {
    let st: PlayState | null = null;
    try {
      st = stateGetter();
    } catch {
      st = null;
    }
    if (!st) return;
    // A readable gameState means the engine is alive and running game code.
    // That's the page-observable proxy for engine_init_complete — the precise
    // WASM-init boundaries are game-side (see the Arc handoff on this bead).
    startup("engine_init_complete");
    if (st.scene) {
      lastScene = st.scene; // furthest location scene, sent on "end"
      stage(st.scene);
      // The title is a scene like any other, so split on its name: anything
      // else that renders is, by definition, the first world scene.
      if (/title/i.test(st.scene)) startup("title_rendered");
      else startup("first_world_scene_ready");
    }
    if (st.touch) stage("m:touch");
    if (st.newGame) {
      stage("m:newgame");
      startup("new_game_confirmed");
    }
    if (st.moving) {
      stage("m:moved");
      startup("first_player_move");
    }
    if (st.dialogue) stage("m:dialogue");
    if (st.inBattle) stage("m:combat");
    // lastTriggeredEventId is -1 (and sometimes 0) when NO story event has
    // fired yet — the game's "nothing yet" sentinel, not a milestone. Emitting
    // it produced a bogus "Story event -1" that appeared for every booted
    // session and read as progress. Only positive ids are real milestones.
    const ev = typeof st.event === "string" ? Number(st.event) : st.event;
    if (ev != null && Number.isFinite(ev) && (ev as number) > 0) {
      stage(`m:event_${ev}`);
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
    emitStartup = null;
    window.removeEventListener("pagehide", end);
    document.removeEventListener("visibilitychange", onHidden);
  };
}
