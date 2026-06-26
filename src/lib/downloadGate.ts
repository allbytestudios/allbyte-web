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

const ACK_KEY = "ab_download_acked";

/** Approx first-load download in MB (WASM + index.pck to Title, then Laria.pck
 *  after New Game). Kept here so the gate copy and any future telemetry agree. */
export const DOWNLOAD_MB = 100;

export function downloadAcked(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export function ackDownload(): void {
  try {
    localStorage.setItem(ACK_KEY, "1");
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
