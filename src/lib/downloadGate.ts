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
  /** Connection looks slow or limited — a 2g/3g effectiveType bucket, a low
   *  downlink estimate, OR high RTT. Deliberately tuned to favor FALSE POSITIVES
   *  over false negatives: the warning is advisory (the user can always
   *  continue), so an occasional false alarm is cheap, but silently letting a
   *  genuinely slow/metered link start a ~75 MB download is the costly miss. */
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
    const downlink: number | null =
      typeof c.downlink === "number" ? c.downlink : null;
    const rtt: number | null = typeof c.rtt === "number" ? c.rtt : null;

    // Coarse bucket: anything below 4g. Includes "3g" on purpose — it's the
    // common metered/slow case and we'd rather warn than miss it.
    const slowBucket = et === "slow-2g" || et === "2g" || et === "3g";
    // effectiveType is lossy; a link can report "4g" yet be genuinely slow.
    // Catch those via the raw estimates. downlink is Mbps (0/unknown guarded);
    // <2 Mbps means the ~75 MB download takes 5+ minutes. rtt is ms.
    const slowDownlink = downlink !== null && downlink > 0 && downlink < 2;
    const highLatency = rtt !== null && rtt >= 500;

    return {
      saveData: !!c.saveData,
      slow: slowBucket || slowDownlink || highLatency,
      supported: true,
    };
  } catch {
    return { saveData: false, slow: false, supported: false };
  }
}
