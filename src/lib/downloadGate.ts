// Download gate.
//
// The game's first load is ~100 MB (WASM + packs). On a metered/cellular plan
// that can cost real money — and our audience is mobile-heavy (iOS Safari #1).
// So we hold the download until the user acknowledges it: nothing is fetched
// until the game iframe's `src` is set, so a pre-launch notice that withholds
// the `src` is a true gate, not a warning-after-the-fact.
//
// Once acknowledged on a device we skip the gate forever — the build is
// service-worker cached, so subsequent loads are instant and use no data.

import gameVersion from "../data/game-version.json";

const ACK_KEY = "ab_download_acked";

/** Approx full first-session download in MB to play the demo: gzip WASM (~9MB)
 *  + index.pck (~24MB) to Title, then Laria.pck (~43MB) after New Game. Down
 *  from ~100MB since the WASM is now served gzip-encoded (~35→9MB). Kept here so
 *  the gate copy and any future telemetry agree. */
export const DOWNLOAD_MB = 75;

/** Current deployed game version — the service worker keys its cache on this,
 *  so when it changes the whole game cache is wiped and re-downloaded. We store
 *  it alongside the ack so a version bump re-prompts (the user is about to pull
 *  ~75MB again, which is the exact data cost the gate exists to disclose). */
function currentVersion(): string {
  return gameVersion.version || "";
}

export type DownloadState =
  | "fresh" // never consented on this device
  | "update" // consented to an OLDER version — a re-download is coming
  | "ready"; // consented to the current version (already cached)

export function downloadState(): DownloadState {
  let acked: string | null = null;
  try {
    acked = localStorage.getItem(ACK_KEY);
  } catch {
    /* private mode — treat as fresh */
  }
  if (!acked) return "fresh";
  if (acked === currentVersion()) return "ready";
  return "update";
}

/** True only when the user has consented to the CURRENT version (so it's
 *  cached and no download is pending). A version bump flips this back to false
 *  via downloadState() === "update". */
export function downloadAcked(): boolean {
  return downloadState() === "ready";
}

export function ackDownload(): void {
  try {
    localStorage.setItem(ACK_KEY, currentVersion());
  } catch {
    /* private mode — gate will just show again next time, which is fine */
  }
}

export interface ConnInfo {
  /** User enabled Data Saver. */
  saveData: boolean;
  /** Effective connection is slow (2g/3g class). */
  slow: boolean;
  /** The Network Information API exists. NOTE: iOS Safari + Firefox return
   *  false here, so a stronger network-aware warning is a *bonus* for Chromium
   *  only — the static disclosure is what every device gets. */
  supported: boolean;
}

export function connectionInfo(): ConnInfo {
  try {
    const c = (navigator as any).connection;
    if (!c) return { saveData: false, slow: false, supported: false };
    const et: string = c.effectiveType || "";
    return {
      saveData: !!c.saveData,
      slow: et === "slow-2g" || et === "2g" || et === "3g",
      supported: true,
    };
  } catch {
    return { saveData: false, slow: false, supported: false };
  }
}
