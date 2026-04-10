import { auth } from "./auth.svelte.ts";

const API = "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com";

export interface SavesSnapshot {
  saves: Record<string, string>;  // { slot_1: '{...}', slot_2: '{...}', ... }
  options: string;
  keymapping: string;
}

export type SyncStatus = "idle" | "syncing" | "synced" | "error" | "unsynced";

class SaveStore {
  /** Last known snapshot from the game (in-memory cache). */
  current = $state<SavesSnapshot>({ saves: {}, options: "", keymapping: "" });
  /** Server sync status (Hero/Legend only). */
  syncStatus = $state<SyncStatus>("idle");
  lastSyncedAt = $state<number | null>(null);
  /** Whether the game has signaled allbyte:ready */
  gameReady = $state(false);
  /** Wire protocol version reported by the game in its ready message. */
  protocolVersion = $state<number | null>(null);
  /** Number of save slots the game declares it supports (12 currently). */
  maxSaveSlots = $state<number | null>(null);
  /** Result of the most recent load-complete ack from the game. */
  lastLoadResult = $state<{
    acceptedSlots: number[];
    rejectedSlots: { slot: number | string; reason: string }[];
  } | null>(null);
  /** Last error message, if any */
  errorMessage = $state<string | null>(null);
}

export const saves = new SaveStore();

let iframeRef: HTMLIFrameElement | null = null;
let pendingPushTimer: ReturnType<typeof setTimeout> | null = null;
/** Messages queued while the game is still booting (before ready). */
const preReadyQueue: any[] = [];

/**
 * Initialize the save bridge: set up window message listener and remember the iframe ref.
 * Call this when the play overlay mounts.
 */
export function initSaveBridge(iframe: HTMLIFrameElement | null) {
  iframeRef = iframe;
  saves.gameReady = false;
  if (typeof window === "undefined") return;
  window.addEventListener("message", handleGameMessage);
  // Test hook: expose state and a postMessage interceptor for Playwright tests
  (window as any).__saves_test = {
    store: saves,
    getCurrent: () => saves.current,
    getSyncStatus: () => saves.syncStatus,
    getMaxSaveSlots: () => saves.maxSaveSlots,
    getProtocolVersion: () => saves.protocolVersion,
    getLastLoadResult: () => saves.lastLoadResult,
    getErrorMessage: () => saves.errorMessage,
    isGameReady: () => saves.gameReady,
    getPreReadyQueueLength: () => preReadyQueue.length,
    /** Sent messages from parent → game, captured for tests */
    sentMessages: [] as any[],
  };
}

export function teardownSaveBridge() {
  iframeRef = null;
  saves.gameReady = false;
  saves.protocolVersion = null;
  saves.maxSaveSlots = null;
  saves.lastLoadResult = null;
  preReadyQueue.length = 0;
  if (typeof window === "undefined") return;
  window.removeEventListener("message", handleGameMessage);
  if (pendingPushTimer) {
    clearTimeout(pendingPushTimer);
    pendingPushTimer = null;
  }
}

function handleGameMessage(e: MessageEvent) {
  const data = e.data;
  if (!data || typeof data !== "object" || typeof data.type !== "string") return;
  if (!data.type.startsWith("allbyte:")) return;

  // Optional source check: if we have an iframe ref, only accept messages from it.
  // Test bypass: window.__saves_test_skip_source_check === true allows tests to
  // dispatch synthetic MessageEvents without setting up a real iframe source.
  const testSkip = typeof window !== "undefined" && (window as any).__saves_test_skip_source_check === true;
  if (!testSkip && iframeRef && e.source !== iframeRef.contentWindow) return;

  switch (data.type) {
    case "allbyte:ready":
      saves.gameReady = true;
      if (typeof data.protocolVersion === "number") {
        saves.protocolVersion = data.protocolVersion;
      }
      if (typeof data.maxSaveSlots === "number") {
        saves.maxSaveSlots = data.maxSaveSlots;
      }
      // Drain any messages queued while we were waiting
      flushPreReadyQueue();
      // On ready, request the current snapshot to populate our cache
      requestSavesFromGame();
      // For Hero/Legend, also pull from server and merge
      if (isSyncTier()) {
        syncFromServer();
      }
      break;

    case "allbyte:save-changed":
      if (typeof data.slotId === "number" && typeof data.data === "string") {
        saves.current.saves[`slot_${data.slotId}`] = data.data;
        // Trigger debounced server push (Hero/Legend only)
        if (isSyncTier()) {
          schedulePushToServer();
        }
      }
      break;

    case "allbyte:all-saves":
      if (data.saves && typeof data.saves === "object") {
        saves.current = {
          saves: { ...data.saves },
          options: typeof data.options === "string" ? data.options : "",
          keymapping: typeof data.keymapping === "string" ? data.keymapping : "",
        };
      }
      break;

    case "allbyte:load-complete":
      saves.lastLoadResult = {
        acceptedSlots: Array.isArray(data.acceptedSlots) ? data.acceptedSlots : [],
        rejectedSlots: Array.isArray(data.rejectedSlots) ? data.rejectedSlots : [],
      };
      if (saves.lastLoadResult.rejectedSlots.length > 0) {
        const reasons = saves.lastLoadResult.rejectedSlots
          .map((r) => `slot ${r.slot}: ${r.reason}`)
          .join("; ");
        saves.errorMessage = `Some saves were rejected: ${reasons}`;
      }
      break;
  }
}

function flushPreReadyQueue() {
  while (preReadyQueue.length > 0) {
    const msg = preReadyQueue.shift();
    if (msg) postToGame(msg);
  }
}

function postToGame(message: any) {
  // Test hook: capture sent messages for inspection
  if (typeof window !== "undefined" && (window as any).__saves_test) {
    (window as any).__saves_test.sentMessages.push(message);
  }
  if (!iframeRef || !iframeRef.contentWindow) return;
  iframeRef.contentWindow.postMessage(message, "*");
}

/**
 * Send a message to the game, but queue it if the game hasn't signaled ready yet.
 * The protocol contract requires we don't send request-saves or load-saves before ready.
 */
function postToGameWhenReady(message: any) {
  if (saves.gameReady) {
    postToGame(message);
  } else {
    preReadyQueue.push(message);
  }
}

export function requestSavesFromGame() {
  postToGameWhenReady({ type: "allbyte:request-saves" });
}

export function loadSavesIntoGame(snapshot: Partial<SavesSnapshot>) {
  postToGameWhenReady({
    type: "allbyte:load-saves",
    saves: snapshot.saves || {},
    options: snapshot.options,
    keymapping: snapshot.keymapping,
  });
  // Update local cache
  if (snapshot.saves) {
    saves.current.saves = { ...saves.current.saves, ...snapshot.saves };
  }
  if (snapshot.options !== undefined) saves.current.options = snapshot.options;
  if (snapshot.keymapping !== undefined) saves.current.keymapping = snapshot.keymapping;
}

/**
 * Trigger a download of the current saves as a JSON file.
 * Requests the current state from the game first, waits briefly, then downloads.
 */
export function downloadSavesFile() {
  // Request fresh snapshot from the game
  requestSavesFromGame();
  // Give it a beat for the response, then build the file
  setTimeout(() => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      ...saves.current,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chronicles-of-nesis-saves-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 300);
}

/**
 * Read a user-uploaded saves file, parse, and inject into the game via postMessage.
 * Returns null on success, error message on failure.
 */
export async function uploadSavesFile(file: File): Promise<string | null> {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.saves) {
      return "File doesn't look like a valid Chronicles of Nesis save file";
    }
    loadSavesIntoGame({
      saves: parsed.saves,
      options: parsed.options,
      keymapping: parsed.keymapping,
    });
    // For Hero/Legend, push to server too
    if (isSyncTier()) {
      schedulePushToServer();
    }
    return null;
  } catch (e: any) {
    return e?.message || "Failed to read file";
  }
}

// === Server sync (Hero/Legend only) ===

function isSyncTier(): boolean {
  const tier = auth.currentUser?.tier;
  return tier === "hero" || tier === "legend";
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("allbyte_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchServerSaves(): Promise<{ saves: string; updatedAt: string } | null> {
  try {
    const resp = await fetch(`${API}/saves`, {
      headers: getAuthHeaders(),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      saves.errorMessage = `Sync error (${resp.status})`;
      return null;
    }
    return await resp.json();
  } catch (e: any) {
    saves.errorMessage = e?.message || "Network error";
    return null;
  }
}

async function pushServerSaves(): Promise<boolean> {
  if (!isSyncTier()) return false;
  saves.syncStatus = "syncing";
  try {
    const blob = JSON.stringify(saves.current);
    const resp = await fetch(`${API}/saves`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ saves: blob }),
    });
    if (!resp.ok) {
      saves.syncStatus = "error";
      saves.errorMessage = `Upload failed (${resp.status})`;
      return false;
    }
    const data = await resp.json();
    saves.lastSyncedAt = data.updatedAt ? Date.parse(data.updatedAt) : Date.now();
    saves.syncStatus = "synced";
    saves.errorMessage = null;
    return true;
  } catch (e: any) {
    saves.syncStatus = "error";
    saves.errorMessage = e?.message || "Network error";
    return false;
  }
}

function schedulePushToServer() {
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  saves.syncStatus = "unsynced";
  pendingPushTimer = setTimeout(() => {
    pendingPushTimer = null;
    pushServerSaves();
  }, 5000);
}

/**
 * Pull server saves and merge into the game (per-slot last-write-wins by timestamp).
 * Called automatically on game ready for Hero/Legend users.
 */
export async function syncFromServer() {
  if (!isSyncTier()) return;
  saves.syncStatus = "syncing";
  const server = await fetchServerSaves();
  if (!server) {
    // No server saves yet — push current state up
    saves.syncStatus = "idle";
    if (Object.keys(saves.current.saves).length > 0) {
      pushServerSaves();
    }
    return;
  }

  let serverSnapshot: SavesSnapshot;
  try {
    serverSnapshot = JSON.parse(server.saves);
  } catch {
    saves.syncStatus = "error";
    saves.errorMessage = "Server save data corrupted";
    return;
  }

  // Per-slot merge using embedded timestamps
  const merged: Record<string, string> = { ...saves.current.saves };
  let serverHasNewer = false;
  for (const [slotKey, serverSlotJson] of Object.entries(serverSnapshot.saves || {})) {
    if (typeof serverSlotJson !== "string" || !serverSlotJson) continue;
    const localSlotJson = merged[slotKey];
    if (!localSlotJson) {
      merged[slotKey] = serverSlotJson;
      serverHasNewer = true;
      continue;
    }
    try {
      const localTs = JSON.parse(localSlotJson)?.timestamp || 0;
      const serverTs = JSON.parse(serverSlotJson)?.timestamp || 0;
      if (serverTs > localTs) {
        merged[slotKey] = serverSlotJson;
        serverHasNewer = true;
      }
    } catch {
      // If we can't parse, keep the local one
    }
  }

  if (serverHasNewer) {
    // Inject merged state into the game
    loadSavesIntoGame({
      saves: merged,
      options: serverSnapshot.options,
      keymapping: serverSnapshot.keymapping,
    });
  }

  saves.syncStatus = "synced";
  saves.lastSyncedAt = server.updatedAt ? Date.parse(server.updatedAt) : Date.now();
}

/**
 * Force an immediate push to the server (cancels any debounced timer).
 * Used by the "Sync now" button.
 */
export async function syncToServerNow(): Promise<boolean> {
  if (pendingPushTimer) {
    clearTimeout(pendingPushTimer);
    pendingPushTimer = null;
  }
  return await pushServerSaves();
}
