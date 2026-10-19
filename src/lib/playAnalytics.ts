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
// it's safe to ship before the backend stack is deployed. It goes to a
// FIRST-PARTY path where that works, falling back to the cross-origin endpoint
// — see SAME_ORIGIN_URL for why, and the transport block in initPlayAnalytics
// for how that choice is made exactly once per session.

// WriteEndpoint output of the play-analytics CloudFormation stack
// (allbyte-studio-play-analytics, us-east-1). Empty string = disabled (no-op).
import { auth } from "./auth.svelte";

// WriteEndpoint output (see below)
const WRITE_URL = "https://pdtoj70foi.execute-api.us-east-1.amazonaws.com/play";

// FIRST-PARTY ingress for the same beacon, proxied to WRITE_URL by CloudFront.
//
// WHY: privacy browsers block CROSS-ORIGIN requests that look like analytics —
// Brave with shields up, uBlock-style extensions — and execute-api.amazonaws.com
// is exactly that shape. The game itself is unaffected, because its assets are
// first-party on this domain, so a blocked session plays perfectly and reports
// nothing. One real itch.io arrival produced full telemetry in September (three
// sessions, 25.6 / 18.6 / 47.9 min, as far as Waterway1-10) and then sessions
// with ZERO beacons in October while CloudFront logged the whole download.
//
// It compounds: the game assets are `immutable, max-age=1yr`, so a RETURNING
// player makes no server requests at all while playing. With the beacon blocked
// there is no instrument left — not even a crude one in the access logs.
//
// The path deliberately avoids every word the blocklists match on ("analytics",
// "beacon", "telemetry", "track", "collect", "pixel", "event") and sits under
// /api/ with the rest of the site's dynamic surface.
//
// This path only exists once CloudFront has a behaviour for it: /api/play/* →
// the play-analytics HTTP API, caching DISABLED, POST allowed, URI rewritten to
// the API's `POST /play` route. Until then the request hits the S3 origin on a
// GET/HEAD-only behaviour and every session falls back to WRITE_URL — which is
// simply today's behaviour, so this is safe to ship ahead of the infra change.
const SAME_ORIGIN_URL = "/api/play/depth";

// The write Lambda's success code, and the ONLY status we accept as proof that
// the first-party path reached it.
//
// DO NOT relax this to `response.ok`. The distribution maps 403 and 404 to
// `200 /index.html` (so deep links survive a refresh), which is distribution-
// WIDE and has no per-behaviour override. Measured 2026-10-19, before any
// behaviour existed: POST https://allbyte.studio/api/play/depth answers 200
// with 92KB of homepage. A 2xx is therefore not evidence of anything; the write
// Lambda's 204 is. Were this `r.ok`, the probe would latch the first-party path
// on a distribution that has no such route and throw the funnel away entirely —
// a far worse failure than the blocking this change exists to fix.
//
// If the backend ever stops returning 204, every session quietly falls back to
// the cross-origin URL — no regression, just no improvement — so update this.
const WRITE_OK_STATUS = 204;
// Longest we hold beacons waiting for the probe to settle (see openAndProbe).
const PROBE_MS = 2500;
// Hard cap on the hold queue. A probe settles in one round trip; this only ever
// matters if it hangs, and a session cannot emit this many stages in 2.5s.
const QUEUE_MAX = 64;

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
  // ?build=<sha> loads an unpromoted dev artifact through the wrapper, so the
  // session is a test by definition — nobody reaches a 40-char sha by accident.
  // Checked FIRST, and without touching storage, because the two markers below
  // both fail here on purpose: save isolation sends the owner to a private
  // window, where he is neither logged in (no admin tier) nor device-tagged
  // (OWNER_KEY cannot persist). Without this, testing a dev build on a phone
  // would enter the funnel as a fresh anonymous player — manufacturing exactly
  // the phantom sessions that took a week to explain away in October.
  try {
    const sha = new URLSearchParams(window.location.search).get("build");
    if (sha && /^[0-9a-f]{40}$/.test(sha)) return true;
  } catch {
    /* unparseable URL — fall through to the normal markers */
  }
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
  /**
   * `gameState.titleContinueEnabled` — the Title screen's Continue button is
   * enabled only when a save exists, so a TRUE reading at Title means this
   * browser has played before. That is the returning-player signal, and it
   * needs no persistent identifier: the game already knows, we just read it.
   * Measured false on a fresh profile, true once a save exists.
   */
  continueAvailable?: boolean;
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
  // Latched when a save is seen at Title BEFORE any new game this session.
  // Declared HERE, not at module scope: `seen` resets per init and this must
  // too, or an Astro ClientRouter navigation away from /play/ and back would
  // carry a stale true and label a fresh session as returning.
  let sawSaveAtTitle = false;
  let lastScene = "";
  let ended = false;
  let poller: ReturnType<typeof setInterval> | null = null;

  const elapsed = () => Math.round((Date.now() - startTs) / 1000);

  // --- Transport: first-party first, cross-origin as the fallback ----------
  //
  // "Send to A, and if that fails send to B" is a trap with sendBeacon. Its
  // boolean means QUEUED-or-not, never DELIVERED: a request a shield is about
  // to drop still queues (true) and then vanishes on the wire with nothing
  // observable. Retrying on anything short of an outright `false` would
  // therefore duplicate every beacon of every ORDINARY session — the common
  // case — in order to rescue the blocked one.
  //
  // So the endpoint is chosen ONCE per session, from a request whose outcome we
  // can actually read, and then never revisited:
  //   - the arrival beacon goes out with fetch() instead of sendBeacon. Same
  //     payload, same endpoint it would have used anyway, so it is not an extra
  //     request — just one we can see the status of.
  //   - a 204 proves the first-party path reaches the write Lambda → latch it.
  //   - a rejection or any other status proves that beacon did NOT land → latch
  //     the cross-origin URL and re-send that one payload there.
  //   - anything emitted while the probe is in flight waits in `queued` and is
  //     flushed, in order, down whichever endpoint wins.
  //
  // After the latch every beacon is sent exactly once, by sendBeacon, to one
  // endpoint. No payload is ever addressed to both.
  let endpoint: string | null = null; // null = probe still in flight
  let probeSettled = false;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  const queued: string[] = [];

  function payload(ev: Ev, scene: string, extra?: Record<string, unknown>): string {
    return JSON.stringify({ sid, ev, scene, dur: elapsed(), ref, dev, ...extra });
  }

  function post(url: string, body: string): void {
    try {
      navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
    } catch {
      /* best-effort; never break the page */
    }
  }

  function latch(url: string): void {
    endpoint = url;
    while (queued.length) post(url, queued.shift() as string);
  }

  // Give up on the probe WITHOUT re-sending the arrival beacon. An in-flight
  // request may already have been processed server-side, so a re-send here
  // could be the one thing this design exists to prevent. One missing `open`
  // row costs that session's `meta`/`ctx`; a duplicated one would be a beacon
  // recorded twice. The session itself still counts — the first `scene` beacon
  // proves it reached the page just as well as `open` does.
  function abandonProbe(): void {
    if (probeSettled) return;
    probeSettled = true;
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
    latch(WRITE_URL);
  }

  function send(ev: Ev, scene: string, extra?: Record<string, unknown>): void {
    try {
      const body = payload(ev, scene, extra);
      if (endpoint) post(endpoint, body);
      else if (queued.length < QUEUE_MAX) queued.push(body);
    } catch {
      /* best-effort; never break the page */
    }
  }

  // Arrival beacon + endpoint probe, in one request. See the block above.
  function openAndProbe(body: string): void {
    const decide = (landed: boolean) => {
      if (probeSettled) return;
      probeSettled = true;
      if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
      }
      // Not landed is a FACT here (fetch rejected, or answered with something
      // other than the write Lambda's 204), which is what makes re-sending it
      // to the other endpoint safe.
      if (!landed) post(WRITE_URL, body);
      latch(landed ? SAME_ORIGIN_URL : WRITE_URL);
    };
    probeTimer = setTimeout(abandonProbe, PROBE_MS);
    try {
      fetch(SAME_ORIGIN_URL, {
        method: "POST",
        // text/plain keeps the request CORS-simple, so the body is byte-identical
        // whichever endpoint it ends up at and the fallback needs no preflight.
        headers: { "Content-Type": "text/plain" },
        body,
        // keepalive is what sendBeacon is built on: the request outlives the
        // document, so an instant bounce still reports. Older Firefox ignores
        // the flag, which only costs us the arrival of a sub-second session.
        keepalive: true,
        // Nothing here is authenticated, and the funnel is anonymous by design.
        credentials: "omit",
        cache: "no-store",
      })
        .then((r) => decide(r.status === WRITE_OK_STATUS))
        .catch(() => decide(false));
    } catch {
      decide(false);
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
  openAndProbe(payload("open", "", { meta: sessionMeta(), ctx: launchContext() }));
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
    // RETURNING vs NEW, without tracking anyone.
    //
    // At Title, Continue is enabled only if a save exists — so a save seen
    // BEFORE any new game means this browser played before. Latched, because
    // starting a new game enables Continue too, and that must not retroactively
    // relabel a first-time player as returning.
    if (!sawSaveAtTitle && st.continueAvailable && !st.newGame && /title/i.test(st.scene || "")) {
      sawSaveAtTitle = true;
      stage("m:returning");
    }
    if (st.newGame) {
      stage("m:newgame");
      startup("new_game_confirmed");
    }
    // Left Title into a world scene, having had a save and never pressing New
    // Game = they pressed Continue. This is the §6 continue_confirmed event,
    // derivable page-side after all rather than needing a game-side emit.
    if (sawSaveAtTitle && !st.newGame && st.scene && !/title/i.test(st.scene)) {
      startup("continue_confirmed");
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
    // Leaving with the probe still in flight: the hold queue has nowhere to go
    // and the page is about to be gone, so commit it to the endpoint we know
    // works. The arrival beacon is not in that queue — it IS the probe — so
    // nothing can go out twice, and this is exactly what shipped before.
    abandonProbe();
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
    // A ClientRouter navigation off /play/ is a SOFT one — no pagehide, so
    // end() never runs. Commit any held beacons before this closure's state is
    // orphaned, or a probe that was still in flight would silently eat them.
    abandonProbe();
    emitStartup = null;
    window.removeEventListener("pagehide", end);
    document.removeEventListener("visibilitychange", onHidden);
  };
}
