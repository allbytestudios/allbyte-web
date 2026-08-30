/**
 * Dev-session bridge — the page half.
 *
 * Registers a LIVE admin game session with the dev-session API, heartbeats the
 * game's state snapshot up, and pumps queued commands down into the iframe. That
 * lets Arc/Quinn watch and mutate the game the owner is actually playing on prod,
 * over HTTP, instead of driving a headless browser (design:
 * Desktop/GameDev/APP_CLAUDE_DEV_SESSION_BRIDGE.md).
 *
 * Protocol (agreed with Arc — the appliers already exist as TestBridge hooks):
 *   game -> page   allbyte:state           { state: <_testGetCombatSnapshot verbatim> }
 *   page -> game   allbyte:command         { seq, verb, args, window }
 *   game -> page   allbyte:command-result  { seq, ok, changed, error, reason }
 *
 * The heartbeat is bidirectional on purpose: one PUT every ~2s carries the new
 * snapshot plus any pending acks UP, and comes back with newly queued commands.
 * That is why this needs no WebSocket — the whole loop is one request.
 *
 * Failure posture: this is a dev convenience riding on the page that serves the
 * actual game. It must never break /play/. Every network path is caught, errors
 * back off exponentially, and nothing here is on the boot path.
 */

const API = "https://lxm37jhf0e.execute-api.us-east-1.amazonaws.com";

/** Foreground cadence. ~2s is imperceptible in conversation and cheap. */
const POLL_MS = 2000;
/** Backgrounded tab: keep the session alive without paying for a dead loop. */
const IDLE_POLL_MS = 15000;
const MAX_BACKOFF_MS = 30000;

export interface DevSessionOptions {
  /** Channel id the session is running (e.g. "alpha-debug"). */
  channel: string;
  /** Game version string, for the agent-side session list. */
  gameVersion?: string;
  /** Human label shown in the session list / console panel. */
  label?: string;
  /** Called on state changes worth surfacing locally (the /test/ panel). */
  onStatus?: (s: DevSessionStatus) => void;
}

export interface DevSessionStatus {
  sessionId: string | null;
  registered: boolean;
  lastHeartbeatAt: number | null;
  commandsApplied: number;
  lastError: string | null;
}

interface PendingResult {
  seq: number;
  ok?: boolean;
  changed?: unknown;
  error?: string;
  reason?: string;
}

let sessionId: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let messageOff: (() => void) | null = null;
let visibilityOff: (() => void) | null = null;
let stopped = true;

let latestState: unknown = null;
let pendingResults: PendingResult[] = [];
let ackedSeq = 0;
let backoff = 0;
let commandsApplied = 0;
let lastError: string | null = null;
let lastHeartbeatAt: number | null = null;
let onStatus: DevSessionOptions["onStatus"] = undefined;

function token(): string | null {
  try {
    return localStorage.getItem("allbyte_token");
  } catch {
    return null;
  }
}

function emitStatus() {
  try {
    onStatus?.({
      sessionId,
      registered: !!sessionId,
      lastHeartbeatAt,
      commandsApplied,
      lastError,
    });
  } catch {
    /* a status consumer must never break the loop */
  }
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const t = token();
  if (!t) throw new Error("no token");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${t}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * One beat: push state + acks, receive commands, forward them to the game.
 * Returns the delay before the next beat, so backoff and cadence live together.
 */
async function beat(iframe: HTMLIFrameElement | null): Promise<number> {
  if (!sessionId || latestState === null) {
    // Nothing to report yet — the game has not emitted a snapshot. Stay quiet
    // rather than registering a session that looks live but carries no state.
    return POLL_MS;
  }
  const results = pendingResults;
  pendingResults = [];
  try {
    const out = await api(`/session/${sessionId}/state`, {
      method: "PUT",
      body: JSON.stringify({ state: latestState, results, ackedSeq }),
    });
    backoff = 0;
    lastError = null;
    lastHeartbeatAt = Date.now();

    for (const cmd of out?.commands || []) {
      if (typeof cmd?.seq !== "number") continue;
      // Commands are handed over in seq order and acked by the game. We advance
      // ackedSeq on DELIVERY so a command is never delivered twice; whether it
      // applied is the game's answer, carried back in allbyte:command-result.
      ackedSeq = Math.max(ackedSeq, cmd.seq);
      commandsApplied++;
      // Targeted origin, never "*". The game hardens the other half of this by
      // origin-checking inbound allbyte:command (Arc), so a malicious embedder
      // can neither inject commands nor observe ours in transit. /godot/ is
      // same-origin with the page, so our own origin is the right target.
      iframe?.contentWindow?.postMessage(
        { type: "allbyte:command", seq: cmd.seq, verb: cmd.verb, args: cmd.args, window: cmd.window },
        window.location.origin,
      );
    }
    emitStatus();
  } catch (e: any) {
    // Put the unsent acks back so a failed beat doesn't lose them.
    pendingResults = results.concat(pendingResults);
    lastError = String(e?.message || e);
    backoff = Math.min(backoff ? backoff * 2 : POLL_MS * 2, MAX_BACKOFF_MS);
    emitStatus();
    return backoff;
  }
  return typeof document !== "undefined" && document.hidden ? IDLE_POLL_MS : POLL_MS;
}

function schedule(iframe: HTMLIFrameElement | null, ms: number) {
  if (stopped) return;
  timer = setTimeout(async () => {
    if (stopped) return;
    const next = await beat(iframe);
    schedule(iframe, next);
  }, ms);
}

/**
 * Start the bridge. Caller is responsible for the gate: admin tier AND the debug
 * channel. This function does not second-guess that, but it is inert without a
 * token, so a non-logged-in visitor can never register a session.
 */
export async function initDevSession(
  iframe: HTMLIFrameElement | null,
  options: DevSessionOptions,
): Promise<void> {
  teardownDevSession();
  if (!token()) return;
  stopped = false;
  onStatus = options.onStatus;

  // Listen before registering: the game may emit its first snapshot immediately.
  const onMessage = (ev: MessageEvent) => {
    // Both halves of the check: the message must come from OUR iframe and from
    // our own origin. State goes on to be stored server-side and read by the
    // agents, so an arbitrary window must not be able to author it.
    if (iframe && ev.source !== iframe.contentWindow) return;
    if (ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "allbyte:state" && d.state !== undefined) {
      latestState = d.state;
    } else if (d.type === "allbyte:command-result" && typeof d.seq === "number") {
      pendingResults.push({
        seq: d.seq,
        ok: d.ok,
        changed: d.changed,
        error: d.error,
        reason: d.reason,
      });
    }
  };
  window.addEventListener("message", onMessage);
  messageOff = () => window.removeEventListener("message", onMessage);

  // A tab returning to the foreground should beat now, not up to 15s from now.
  const onVisibility = () => {
    if (stopped || document.hidden) return;
    if (timer) clearTimeout(timer);
    schedule(iframe, 0);
  };
  document.addEventListener("visibilitychange", onVisibility);
  visibilityOff = () => document.removeEventListener("visibilitychange", onVisibility);

  // Seed the game's parent-origin capture. The game pins its outbound
  // allbyte:state to the origin it learned from an inbound allbyte:* message
  // (window.__nesisAllbyteParentOrigin), falling back to document.referrer and
  // finally to "*". Without this the first emits would ride the fallback path,
  // because nothing else here posts to the game until a command exists. One
  // benign hello on init makes the pinning deterministic instead.
  try {
    iframe?.contentWindow?.postMessage(
      { type: "allbyte:hello", role: "dev-session" },
      window.location.origin,
    );
  } catch {
    /* iframe not ready yet — the emitter's referrer fallback still covers it */
  }

  try {
    const reg = await api("/session", {
      method: "POST",
      body: JSON.stringify({
        channel: options.channel,
        gameVersion: options.gameVersion || "",
        label: options.label || "",
      }),
    });
    sessionId = reg?.sessionId || null;
    lastError = null;
  } catch (e: any) {
    // 403 here is the normal, correct answer for a non-admin. Stay silent.
    sessionId = null;
    lastError = String(e?.message || e);
  }
  emitStatus();
  if (sessionId) schedule(iframe, POLL_MS);
}

export function teardownDevSession() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  messageOff?.();
  visibilityOff?.();
  messageOff = null;
  visibilityOff = null;
  sessionId = null;
  latestState = null;
  pendingResults = [];
  ackedSeq = 0;
  backoff = 0;
  commandsApplied = 0;
  lastHeartbeatAt = null;
}

/* ---- read side: used by the /test/ console panel, not by /play/ ---- */

export interface LiveSession {
  sessionId: string;
  channel?: string;
  gameVersion?: string;
  label?: string;
  updatedAt?: number;
  staleSeconds?: number;
  cmdSeq?: number;
  ackedSeq?: number;
}

/** List the caller's live sessions. Admin-gated server-side. */
export async function listSessions(): Promise<LiveSession[]> {
  const out = await api("/sessions");
  return out?.sessions || [];
}

/** Read one session's latest state snapshot. */
export async function readSession(id: string): Promise<any> {
  return api(`/session/${encodeURIComponent(id)}`);
}

/** Enqueue a command. The console exposes this for hand-driven testing. */
export async function sendCommand(
  id: string,
  verb: string,
  args: Record<string, unknown> = {},
  window_: string = "any",
): Promise<{ ok: boolean; seq: number }> {
  return api(`/session/${encodeURIComponent(id)}/commands`, {
    method: "POST",
    body: JSON.stringify({ verb, args, window: window_ }),
  });
}
