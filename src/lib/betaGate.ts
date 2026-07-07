// Beta channel gate — client half of the CloudFront signed-cookie flow.
//
// The beta base build (/godot/beta/*) is enforced at the EDGE: a CloudFront
// behavior with TrustedKeyGroups refuses requests without valid signed
// cookies. This module obtains those cookies before the game iframe mounts:
// GET /game/beta-cookies with the user's JWT → the API verifies tier
// (Initiate+) fresh from the users table and Set-Cookies three CloudFront
// cookies scoped to Domain=allbyte.studio; Path=/godot/beta.
//
// The fetch is cross-origin (api.allbyte.studio) but same-site, sent with
// `credentials: "include"` so the browser honors the Set-Cookie headers.
// Subsequent same-origin requests to /godot/beta/* (the iframe, the engine's
// wasm/pck fetches, the service worker's network fetches) all carry the
// cookies automatically.
//
// IMPORTANT: this is UX sequencing, not the security boundary — the edge
// check is. If this module never runs, an entitled user just sees a 403 page
// instead of the game; an unentitled user is refused either way.

const API = "https://api.allbyte.studio";

export type BetaGateResult =
  | "granted" // cookies set; safe to mount the beta iframe
  | "denied" // 401/403 — not logged in or tier below Initiate
  | "unconfigured" // 503 — backend deployed without the key ceremony
  | "error"; // network/unexpected — try again later

let expiresAt = 0; // epoch seconds of the current grant, 0 = none
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** True if `path` points into the gated beta channel. */
export function isBetaPath(path: string): boolean {
  return path.startsWith("/godot/beta/");
}

/**
 * Ensure valid beta cookies exist, fetching a fresh grant if absent or
 * within 20% of expiry. Schedules a background refresh at ~80% TTL so a
 * long play session never hits an expired-cookie 403 mid-game (the SW's
 * cache-first wasm/pck entries keep working regardless; it's fresh fetches
 * that need live cookies).
 */
export async function ensureBetaCookies(): Promise<BetaGateResult> {
  const now = Date.now() / 1000;
  if (expiresAt > now + 60) return "granted"; // current grant, >1min left

  const token =
    typeof localStorage !== "undefined" ? localStorage.getItem("allbyte_token") : null;
  if (!token) return "denied";
  let res: Response;
  try {
    res = await fetch(`${API}/game/beta-cookies`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
    });
  } catch {
    return "error";
  }
  if (res.status === 401 || res.status === 403) return "denied";
  if (res.status === 503) return "unconfigured";
  if (!res.ok) return "error";
  try {
    const body = await res.json();
    expiresAt = Number(body.expiresAt) || 0;
  } catch {
    expiresAt = 0;
  }
  scheduleRefresh();
  return "granted";
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const now = Date.now() / 1000;
  if (!expiresAt || expiresAt <= now) return;
  const inMs = Math.max(30_000, (expiresAt - now) * 0.8 * 1000);
  refreshTimer = setTimeout(() => {
    expiresAt = 0; // force a real re-fetch
    void ensureBetaCookies();
  }, inMs);
}

/** Tear down the background refresh (component unmount). */
export function stopBetaRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}
