import { auth } from './auth.svelte.ts';
import { MAX_TRANSFER_BYTES, parseBackup, parseSnapshot, SaveRequests, type Snapshot } from './save-transfer';
const API = 'https://api.allbyte.studio';
export interface SavesSnapshot extends Snapshot {}
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'unsynced';
class SaveStore {
  current = $state<SavesSnapshot>({ saves: {}, options: '', keymapping: '' });
  syncStatus = $state<SyncStatus>('idle');
  lastSyncedAt = $state<number | null>(null);
  gameReady = $state(false);
  protocolVersion = $state<number | null>(null);
  maxSaveSlots = $state<number | null>(null);
  saveCapabilities = $state<{ correlatedRequests?: boolean; atomicImport?: boolean; importConfirmation?: boolean }>({});
  lastLoadResult = $state<{ acceptedSlots: number[]; rejectedSlots: { slot: number | string; reason: string }[] } | null>(null);
  errorMessage = $state<string | null>(null);
}
export const saves = new SaveStore();
const requests = new SaveRequests();
let iframeRef: HTMLIFrameElement | null = null;
let importFileInput: HTMLInputElement | null = null;
let exitCallback: (() => void) | null = null;
let sessionId = '';
let generation = 0;
let mutation = 0;
let busy = false;
let pickerOpen = false;
let unknownImportId = '';
let unknownImportAccount = '';
let pendingPushTimer: ReturnType<typeof setTimeout> | null = null;
let cloudQueue: Promise<unknown> = Promise.resolve();
let revisionAccount = '';
let serverRevision: number | null = null;
let cloudConflict = false;
// Account-scoped restore intent survives reload until its conditional upload is
// acknowledged. Never persist a host copy of the slot payload here.
function restoreKey(account: string) { return `allbyte_save_restore_v1:${account}`; }
function restoreIntent(account: string): { revision: number | null } | null {
  const raw = localStorage.getItem(restoreKey(account));
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (parsed.revision !== null && (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0)) throw Error('Invalid pending cloud restore record');
  return parsed;
}
export interface SaveBridgeOptions { onExit?: () => void }
function context() {
  const account = auth.currentUser?.userId ?? '';
  if (revisionAccount !== account) { revisionAccount = account; serverRevision = null; cloudConflict = false; }
  return { account, generation, mutation };
}
function valid(c: ReturnType<typeof context>) {
  return c.account === (auth.currentUser?.userId ?? '') && c.generation === generation && c.mutation === mutation;
}
function sameSession(c: ReturnType<typeof context>) {
  return c.account === (auth.currentUser?.userId ?? '') && c.generation === generation;
}
function cloudSerial<T>(work: () => Promise<T>): Promise<T> {
  const next = cloudQueue.then(work, work);
  cloudQueue = next.catch(() => undefined);
  return next;
}
function postToGame(message: object) {
  if (!iframeRef?.contentWindow) return;
  if (import.meta.env.DEV) (window as any).__saves_test?.sentMessages.push(message);
  iframeRef.contentWindow.postMessage({ protocolVersion: 2, ...message }, new URL(iframeRef.src || window.location.href, window.location.href).origin);
}
function reportTransfer(status: string, message: string) {
  saves.errorMessage = status === 'error' ? message : null;
  postToGame({ type: 'allbyte:save-transfer-result', status, message });
}
function requireProtocol() {
  if (!saves.gameReady || saves.protocolVersion !== 2 || !sessionId || saves.saveCapabilities.correlatedRequests !== true) throw Error('This game build does not support reliable save transfer yet.');
}
async function freshSnapshot(): Promise<Snapshot> {
  requireProtocol();
  const requestId = crypto.randomUUID();
  const reply = requests.wait(requestId, 'allbyte:all-saves', sessionId, 5000);
  postToGame({ type: 'allbyte:request-saves', requestId, sessionId });
  return parseSnapshot(await reply, saves.maxSaveSlots ?? 12);
}
export function initSaveBridge(iframe: HTMLIFrameElement | null, options: SaveBridgeOptions = {}) {
  teardownSaveBridge();
  iframeRef = iframe;
  exitCallback = options.onExit ?? null;
  if (typeof window === 'undefined') return;
  window.addEventListener('message', handleGameMessage);
  document.addEventListener('visibilitychange', broadcastVisibility);
  importFileInput = document.createElement('input');
  importFileInput.type = 'file';
  importFileInput.accept = 'application/json,.json';
  importFileInput.style.position = 'absolute';
  importFileInput.style.left = '-9999px';
  importFileInput.addEventListener('change', handleImportFileChosen);
  importFileInput.addEventListener('cancel', handlePickerCancel);
  document.body.appendChild(importFileInput);
  (window as any).allbyteRequestExit = () => exitCallback?.();
  (window as any).allbyteRequestExport = () => void downloadSavesFile();
  // Synchronous call preserves browser activation when Godot forwards a gesture.
  (window as any).allbyteRequestImport = () => {
    try {
      requireProtocol();
      if (busy || pickerOpen || unknownImportId) throw Error('A save transfer is already pending.');
      if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.isActive) throw Error('The browser needs an active click to open the chooser. Select Import with a mouse or touch.');
      pickerOpen = true;
      importFileInput?.click();
    } catch (e) { pickerOpen = false; reportTransfer('error', (e as Error).message); }
  };
  if (import.meta.env.DEV) (window as any).__saves_test = {
    store: saves, getCurrent: () => saves.current, getSyncStatus: () => saves.syncStatus,
    getMaxSaveSlots: () => saves.maxSaveSlots, getProtocolVersion: () => saves.protocolVersion,
    getLastLoadResult: () => saves.lastLoadResult, getErrorMessage: () => saves.errorMessage,
    isGameReady: () => saves.gameReady, getPreReadyQueueLength: () => 0,
    getIsSyncTier: () => !!auth.currentUser, sentMessages: [],
    setTestTier: (tier: string) => {
      auth.currentUser = auth.currentUser ? { ...auth.currentUser, tier } :
        { userId: 'test', email: 'test@allbyte.studio', username: 'test', tier,
          stripeCustomerId: null, notificationPreferences: null } as any;
    },
  };
}
export function teardownSaveBridge() {
  generation++; mutation++; requests.cancel();
  iframeRef = null; exitCallback = null; sessionId = ''; busy = false; pickerOpen = false;
  unknownImportId = ''; serverRevision = null; cloudConflict = false;
  saves.gameReady = false; saves.protocolVersion = null; saves.maxSaveSlots = null;
  saves.saveCapabilities = {};
  saves.lastLoadResult = null; saves.current = { saves: {}, options: '', keymapping: '' };
  saves.syncStatus = 'idle'; saves.lastSyncedAt = null; saves.errorMessage = null;
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  pendingPushTimer = null;
  if (typeof window === 'undefined') return;
  window.removeEventListener('message', handleGameMessage);
  document.removeEventListener('visibilitychange', broadcastVisibility);
  importFileInput?.removeEventListener('change', handleImportFileChosen);
  importFileInput?.removeEventListener('cancel', handlePickerCancel);
  importFileInput?.remove(); importFileInput = null;
  delete (window as any).allbyteRequestExit;
  delete (window as any).allbyteRequestExport;
  delete (window as any).allbyteRequestImport;
  delete (window as any).__saves_test;
}
function broadcastVisibility() { postToGame({ type: 'allbyte:visibility', visible: document.visibilityState === 'visible' }); }
function handlePickerCancel() { pickerOpen = false; reportTransfer('cancelled', ''); }
async function handleImportFileChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  pickerOpen = false;
  const file = input.files?.[0]; input.value = '';
  if (file) await uploadSavesFile(file);
}
function handleGameMessage(e: MessageEvent) {
  const data = e.data;
  if (!iframeRef || !data || typeof data !== 'object' || typeof data.type !== 'string') return;
  const origin = new URL(iframeRef.src || window.location.href, window.location.href).origin;
  const bypass = import.meta.env.DEV && (window as any).__saves_test_skip_source_check === true;
  if (!bypass && (e.source !== iframeRef.contentWindow || e.origin !== origin)) return;
  const saveMessage = ['allbyte:all-saves', 'allbyte:load-complete', 'allbyte:load-pending', 'allbyte:save-changed'].includes(data.type);
  if (saveMessage && (!sessionId || data.sessionId !== sessionId || data.protocolVersion !== 2)) return;
  if (requests.accept(data)) return;
  switch (data.type) {
    case 'allbyte:request-exit': exitCallback?.(); return;
    case 'allbyte:request-export-saves': void downloadSavesFile(); return;
    case 'allbyte:request-import-saves': (window as any).allbyteRequestImport?.(); return;
    case 'allbyte:ready': {
      if (typeof data.sessionId !== 'string' || !data.sessionId || data.protocolVersion !== 2 ||
          !Number.isInteger(data.maxSaveSlots) || data.maxSaveSlots < 1 || data.maxSaveSlots > 12) return;
      if (sessionId === data.sessionId && saves.gameReady) return;
      requests.cancel(); generation++; sessionId = data.sessionId; busy = false; pickerOpen = false; cloudConflict = false;
      unknownImportId = ''; serverRevision = null;
      saves.gameReady = true; saves.protocolVersion = 2; saves.maxSaveSlots = data.maxSaveSlots;
      saves.saveCapabilities = data.saveCapabilities ?? {};
      saves.current = { saves: {}, options: '', keymapping: '' };
      broadcastSyncStatus(); broadcastAccount();
      if (auth.currentUser) void syncFromServer();
      else {
        const c = context();
        void freshSnapshot().then(snapshot => { if (valid(c)) saves.current = snapshot; })
          .catch(e => { if (valid(c)) reportTransfer('error', e.message); });
      }
      return;
    }
    case 'allbyte:save-changed': {
      if (!Number.isInteger(data.slotId) || data.slotId < 1 || data.slotId > (saves.maxSaveSlots ?? 12) || typeof data.data !== 'string') return;
      mutation++; saves.current.saves[`slot_${data.slotId}`] = data.data;
      if (auth.currentUser) schedulePushToServer();
      return;
    }
    case 'allbyte:load-complete':
      if (unknownImportId && data.requestId === unknownImportId && unknownImportAccount === (auth.currentUser?.userId ?? '')) {
        try {
          if (data.ok) saves.current = parseSnapshot(data.snapshot, saves.maxSaveSlots ?? 12);
          else if (unknownImportAccount) localStorage.removeItem(restoreKey(unknownImportAccount));
          unknownImportId = '';
          if (data.ok && auth.currentUser) schedulePushToServer();
        } catch (e) { reportTransfer('error', (e as Error).message); }
      }
      return;
  }
}
export async function requestSavesFromGame() {
  const c = context(); const snapshot = await freshSnapshot();
  if (!valid(c)) throw Error('Game or account changed during snapshot request');
  saves.current = snapshot; return snapshot;
}
export async function loadSavesIntoGame(snapshot: Partial<SavesSnapshot>, opts: { source?: 'local' | 'cloud' | 'import'; cloudSlots?: string[] } = {}) {
  requireProtocol();
  if (saves.saveCapabilities.atomicImport !== true || saves.saveCapabilities.importConfirmation !== true) throw Error('This game build does not support confirmed durable imports.');
  const c = context(); const requestId = crypto.randomUUID();
  if (opts.source === 'import') { unknownImportId = requestId; unknownImportAccount = c.account; }
  const reply = requests.wait(requestId, 'allbyte:load-complete', sessionId, 120000);
  postToGame({ type: 'allbyte:load-saves', ...snapshot, requestId, sessionId,
    source: opts.source ?? 'local', cloudSlots: opts.cloudSlots ?? [] });
  let result;
  try { result = await reply; }
  catch (e) { if (sameSession(c) && opts.source === 'import') unknownImportId = requestId; throw e; }
  if (!(opts.source === 'import' ? sameSession(c) : valid(c))) throw Error('Game or account changed during save transfer');
  if (typeof result.ok !== 'boolean') throw Error('Import result unknown: malformed game acknowledgment.');
  saves.lastLoadResult = { acceptedSlots: result.acceptedSlots ?? [], rejectedSlots: result.rejectedSlots ?? [] };
  if (!result.ok) {
    if (opts.source === 'import') unknownImportId = '';
    throw Error(result.reason === 'cancelled' ? 'Import cancelled' : `Import failed: ${result.reason || 'unknown error'}`);
  }
  saves.current = parseSnapshot(result.snapshot, saves.maxSaveSlots ?? 12);
  if (opts.source === 'import') unknownImportId = '';
  return result;
}
export async function downloadSavesFile() {
  if (busy || pickerOpen || unknownImportId) return reportTransfer('error', 'A save transfer is already pending.');
  const c = context(); busy = true;
  try {
    const snapshot = await freshSnapshot();
    if (!valid(c)) throw Error('Game or account changed during export');
    const payload = { version: 1, game: 'chronicles-of-nesis', exportedAt: new Date().toISOString(), ...snapshot };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url;
    a.download = `chronicles-of-nesis-saves-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    reportTransfer('success', 'Save download started.');
  } catch (e) { if (c.generation === generation) reportTransfer('error', (e as Error).message); }
  finally { if (c.generation === generation) busy = false; }
}
export async function uploadSavesFile(file: File): Promise<string | null> {
  if (busy || unknownImportId) { reportTransfer('error', 'A save transfer is already pending.'); return 'A save transfer is already pending.'; }
  busy = true; mutation++;
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  pendingPushTimer = null;
  const c = context();
  let markedRestore = false;
  try {
    requireProtocol();
    if (file.size > MAX_TRANSFER_BYTES) throw Error('Save file is too large');
    const snapshot = parseBackup(await file.text(), saves.maxSaveSlots ?? 12);
    await cloudSerial(async () => {
      if (!valid(c)) throw Error('Game or account changed during import');
      if (c.account) {
        if (cloudConflict) throw Error('Resolve the existing cloud conflict before importing another backup.');
        if (serverRevision === null) {
          try { await fetchServerSaves(c); }
          catch (e) { if (!valid(c)) throw e; }
        }
        if (!valid(c)) throw Error('Game or account changed during import');
        localStorage.setItem(restoreKey(c.account), JSON.stringify({ revision: serverRevision }));
        markedRestore = true;
      }
      // Settings remain off until the game offers an explicit opt-in control.
      await loadSavesIntoGame({ saves: snapshot.saves }, { source: 'import' });
    });
    if (sameSession(c) && auth.currentUser) schedulePushToServer();
    return null;
  } catch (e) {
    const message = (e as Error).message;
    if (markedRestore && !unknownImportId && sameSession(c)) localStorage.removeItem(restoreKey(c.account));
    if (c.generation === generation) reportTransfer(message === 'Import cancelled' ? 'cancelled' : 'error', message);
    return message === 'Import cancelled' ? null : message;
  } finally { if (c.generation === generation) busy = false; }
}
function broadcastSyncStatus() {
  if (saves.gameReady) postToGame({ type: 'allbyte:sync-status', status: saves.syncStatus,
    lastSyncedAt: saves.lastSyncedAt, errorMessage: saves.errorMessage });
}
function setSyncStatus(status: SyncStatus, message: string | null = null) {
  saves.syncStatus = status; saves.errorMessage = message; broadcastSyncStatus();
}
function broadcastAccount() {
  const u = auth.currentUser;
  postToGame({ type: 'allbyte:account', username: u?.username ?? null, tier: u?.tier ?? 'default', cloudSaves: !!u });
}
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('allbyte_token'); return token ? { Authorization: `Bearer ${token}` } : {};
}
function playerSlotsOnly(all: Record<string, string>) {
  return Object.fromEntries(Object.entries(all).filter(([key, value]) => /^slot_[1-9]\d*$/.test(key) && Number(key.slice(5)) <= (saves.maxSaveSlots ?? 12) && typeof value === 'string'));
}
async function fetchServerSaves(c: ReturnType<typeof context>): Promise<Snapshot | null> {
  const response = await fetch(`${API}/saves`, { headers: getAuthHeaders() });
  if (!valid(c)) throw Error('Account or saves changed during cloud request');
  if (response.status !== 404 && !response.ok) throw Error(`Cloud download failed (${response.status})`);
  const data = await response.json();
  if (!valid(c)) throw Error('Account or saves changed during cloud request');
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw Error('Cloud API needs the revision-support update before syncing.');
  serverRevision = data.revision;
  return response.status === 404 ? null : parseSnapshot(JSON.parse(data.saves), saves.maxSaveSlots ?? 12);
}
async function pushServerSaves(): Promise<boolean> {
  const c = context();
  if (!c.account || busy || unknownImportId || cloudConflict || !saves.gameReady) return false;
  setSyncStatus('syncing');
  try {
    const intent = restoreIntent(c.account);
    if (intent && intent.revision === null) {
      cloudConflict = true;
      throw Error('Saves were imported locally while cloud was unavailable. Confirm which copy to keep before syncing.');
    }
    if (intent) serverRevision = intent.revision;
    else if (serverRevision === null) await fetchServerSaves(c);
    if (!valid(c) || busy || unknownImportId) return false;
    const snapshot = await freshSnapshot();
    if (!valid(c) || busy || unknownImportId) return false;
    const response = await fetch(`${API}/saves`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ saves: JSON.stringify({ ...snapshot, saves: playerSlotsOnly(snapshot.saves) }), expectedRevision: serverRevision }),
    });
    if (!valid(c)) { serverRevision = null; return false; }
    if (response.status === 409) {
      cloudConflict = true;
      throw Error('Cloud saves changed elsewhere. Local saves are kept; resolve the conflict before uploading.');
    }
    if (!response.ok) throw Error(`Cloud upload failed (${response.status}). Saves remain local.`);
    const result = await response.json();
    if (!valid(c)) { serverRevision = null; return false; }
    if (!Number.isSafeInteger(result.revision)) throw Error('Cloud returned an invalid revision');
    serverRevision = result.revision;
    if (intent) localStorage.removeItem(restoreKey(c.account));
    saves.lastSyncedAt = Date.parse(result.updatedAt) || Date.now();
    setSyncStatus('synced'); return true;
  } catch (e) { if (valid(c)) setSyncStatus('error', (e as Error).message); return false; }
}
function schedulePushToServer() {
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  setSyncStatus('unsynced'); const c = context();
  pendingPushTimer = setTimeout(() => {
    pendingPushTimer = null;
    if (valid(c)) void cloudSerial(() => valid(c) ? pushServerSaves() : Promise.resolve(false));
  }, 5000);
}
export function syncFromServer(): Promise<void> {
  const c = context();
  return cloudSerial(async () => {
    if (!c.account || !valid(c) || busy || unknownImportId || cloudConflict) return;
    setSyncStatus('syncing');
    try {
      if (restoreIntent(c.account)) { await pushServerSaves(); return; }
      const local = await freshSnapshot();
      if (!valid(c)) return;
      saves.current = local;
      const server = await fetchServerSaves(c);
      if (!valid(c) || busy || unknownImportId) return;
      if (!server) { await pushServerSaves(); return; }
      const merged = { ...local.saves }; const cloudSlots: string[] = [];
      for (const [key, value] of Object.entries(server.saves)) {
        let newer = !merged[key];
        if (!newer) {
          try {
            const remoteTime = JSON.parse(value)?.timestamp; const localTime = JSON.parse(merged[key])?.timestamp;
            newer = Number.isFinite(remoteTime) && Number.isFinite(localTime) && remoteTime > localTime;
          } catch { continue; }
        }
        if (newer) { merged[key] = value; cloudSlots.push(key); }
      }
      if (cloudSlots.length) await loadSavesIntoGame({ saves: merged }, { source: 'cloud', cloudSlots });
      if (valid(c)) setSyncStatus('synced');
    } catch (e) { if (valid(c)) setSyncStatus('error', (e as Error).message); }
  });
}
export function syncToServerNow(): Promise<boolean> {
  const c = context();
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  pendingPushTimer = null; return cloudSerial(() => valid(c) ? pushServerSaves() : Promise.resolve(false));
}
