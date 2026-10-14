import { auth } from './auth.svelte.ts';
import { MAX_TRANSFER_BYTES, parseBackup, parseSnapshot, SaveRequests, type Snapshot } from './save-transfer';
import { NativeFilePrompt, restoreGameFocus, type PromptEvent } from './native-file-prompt';
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
let nativePrompt: NativeFilePrompt | null = null;
let removeFrameLoadListener: (() => void) | null = null;
let exitCallback: (() => void) | null = null;
let sessionId = '';
let generation = 0;
let mutation = 0;
let busy = false;
let unknownImportId = '';
let unknownImportAccount = '';
let stopTraceListeners: (() => void) | null = null;
let traceSequence = 0;
let traceInputs = 0;
let traceStateMessages = 0;
const traceEntries: Record<string, unknown>[] = [];
const traceInstance = import.meta.env.DEV ? crypto.randomUUID() : '';
function elementKind(doc: Document | null) {
  const el = doc?.activeElement;
  if (!el) return 'none';
  if (el === doc?.body) return 'body';
  if (el === doc?.documentElement) return 'document';
  if (el.tagName === 'CANVAS') return 'canvas';
  if (el.tagName === 'IFRAME') return 'iframe';
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') return 'file_input';
  return 'other_control';
}
function trace(event: string, fields: Record<string, unknown> = {}) {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  // `allbyte:state` arrives at a rate set by the game, and it bursts: measured
  // 2026-10-14, 252 of the ring's 256 entries were state pings inside six
  // seconds, while a quiet Title posts 3 in thirty. A burst therefore evicted
  // the transfer events the ring exists to preserve — right when a transfer is
  // the thing being diagnosed — and buried them in the console besides. Count
  // them instead; every entry below carries the running total, so "is the game
  // still talking" stays answerable at any rate without the flood.
  if (event === 'message_received' && fields.type === 'allbyte:state') { traceStateMessages++; return; }
  try {
    let game: Record<string, unknown> = { accessible: false };
    try {
      const doc = iframeRef?.contentDocument;
      if (doc) game = { accessible: true, visible: doc.visibilityState, focused: doc.hasFocus(), activeElement: elementKind(doc),
        version: String((iframeRef?.contentWindow as any)?.gameState?.version ?? 'unknown') };
    } catch {}
    const host = { visible: document.visibilityState, focused: document.hasFocus(), activeElement: elementKind(document),
      siteBuild: String((window as any).__SITE_BUILD ?? 'unknown'),
      iframePath: iframeRef ? new URL(iframeRef.src, window.location.href).pathname : null };
    traceEntries.push({ sequence: ++traceSequence, time: Date.now(), event,
      instanceId: traceInstance, sessionId, requestId: unknownImportId || null,
      ...nativePrompt?.diagnosticState, busy, stateMsgs: traceStateMessages, ...fields, host, game });
    if (traceEntries.length > 256) traceEntries.shift();
    // Mirror every event to the console as ONE greppable line. The ring above
    // keeps the full record, but nothing surfaced it, so the wrapper half of a
    // save transfer was invisible from a browser session or a driven console
    // capture — diagnosing "did the bridge even get called?" required
    // monkey-patching allbyteRequestImport (Arc 2026-10-14). Prefixed `[saves]`
    // to match `[loader]`; DEV only, same as the rest of this facility.
    console.log(`[saves] ${event} ` + JSON.stringify({
      seq: traceSequence, ...fields, busy,
      prompt: nativePrompt ? { active: nativePrompt.active, recovering: nativePrompt.recovering } : null,
      hostFocus: host.focused, hostActive: host.activeElement,
      gameFocus: game.focused ?? null, gameActive: game.activeElement ?? null,
    }));
  } catch { /* Diagnostics must never interfere with a save operation. */ }
}
function traceMessage(event: string, data: any, rejection?: string) {
  if (!import.meta.env.DEV) return;
  const id = (value: unknown) => typeof value === 'string' ? value.slice(0, 128) : null;
  trace(event, { type: id(data.type), requestId: id(data.requestId), messageSessionId: id(data.sessionId),
    messagePromptId: id(data.promptId), rejection, ok: typeof data.ok === 'boolean' ? data.ok : undefined,
    reason: typeof data.reason === 'string' && /^[a-z_]{1,64}$/.test(data.reason) ? data.reason : undefined });
}
function recoverNativeFocus(stage: string) {
  restoreGameFocus(document, iframeRef, result => trace('focus_attempt', { stage, ...result }));
}
export function traceSaveVisibility(visible: boolean) {
  trace('visibility_sent', { visible });
}
// Cloud saves are retired for now. Manual transfers never consult cloud state.
export interface SaveBridgeOptions { onExit?: () => void }
export function isNativeFilePromptActive() { return nativePrompt?.active ?? false; }
export function isNativeFilePromptRecovery() { return nativePrompt?.recovering ?? false; }
function handleNativePrompt(event: PromptEvent) {
  if (event.phase === 'opening') traceInputs = 0;
  trace('native_prompt', { ...event });
  if (event.phase === 'returned') recoverNativeFocus('returned');
  postToGame({ type: 'allbyte:native-file-prompt', sessionId, ...event });
  window.dispatchEvent(new CustomEvent('allbyte:native-file-prompt', { detail: event }));
  if (event.outcome === 'cancelled') reportTransfer('cancelled', '');
}
function handleNativeSettled() {
  trace('input_removed');
  recoverNativeFocus('settled');
  window.dispatchEvent(new CustomEvent('allbyte:native-file-prompt-settled'));
}
function context() {
  const account = auth.currentUser?.userId ?? '';
  return { account, generation, mutation };
}
function valid(c: ReturnType<typeof context>) {
  return c.account === (auth.currentUser?.userId ?? '') && c.generation === generation && c.mutation === mutation;
}
function sameSession(c: ReturnType<typeof context>) {
  return c.account === (auth.currentUser?.userId ?? '') && c.generation === generation;
}
function postToGame(message: object) {
  if (!iframeRef?.contentWindow) return;
  traceMessage('message_sent', message);
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
  if (import.meta.env.DEV) {
    const read = () => JSON.parse(JSON.stringify(traceEntries));
    Object.defineProperty(window, '__allbyteSaveTrace', { configurable: true,
      value: Object.freeze({ read, schemaVersion: 1 }) });
    const cleanups: (() => void)[] = [];
    const listen = (target: EventTarget, type: string, fn: EventListener) => {
      target.addEventListener(type, fn, true);
      cleanups.push(() => { try { target.removeEventListener(type, fn, true); } catch {} });
    };
    for (const type of ['focus', 'blur', 'pageshow', 'pagehide']) listen(window, type, () => trace('host_' + type));
    for (const type of ['visibilitychange', 'fullscreenchange']) listen(document, type, () => trace('host_' + type));
    const watch = () => {
      try {
        if (!iframe?.contentWindow) return;
        for (const type of ['focus', 'blur']) listen(iframe.contentWindow, type, () => trace('game_' + type));
        for (const type of ['pointerdown', 'keydown']) listen(iframe.contentWindow, type, event => {
          if (!event.isTrusted || !nativePrompt?.diagnosticState.promptId || traceInputs >= 8) return;
          traceInputs++;
          trace('game_input_capture', { inputType: type, repeat: !!(event as KeyboardEvent).repeat });
        });
      } catch {}
    };
    watch();
    iframe?.addEventListener('load', watch);
    stopTraceListeners = () => { iframe?.removeEventListener('load', watch); cleanups.forEach(fn => fn()); };
    trace('bridge_initialized');
  }
  window.addEventListener('message', handleGameMessage);
  nativePrompt = new NativeFilePrompt(window, document, handleNativePrompt,
    file => { trace('file_selected', { bytes: file.size }); void uploadSavesFile(file); }, handleNativeSettled);
  let removeFrameInteractions: (() => void) | undefined;
  const watchFrame = () => {
    removeFrameInteractions?.();
    try { if (iframe?.contentWindow) removeFrameInteractions = nativePrompt?.watchInteractions(iframe.contentWindow); }
    catch { /* Unsupported cross-origin embedding still uses host return events. */ }
  };
  const frameLoaded = () => {
    // A chooser belongs to one loaded document. Retire it even if the new game
    // never reaches ready, so an old OS callback cannot target the new frame.
    nativePrompt?.destroy();
    nativePrompt = new NativeFilePrompt(window, document, handleNativePrompt,
      file => { trace('file_selected', { bytes: file.size }); void uploadSavesFile(file); }, handleNativeSettled);
    watchFrame();
  };
  watchFrame();
  iframe?.addEventListener('load', frameLoaded);
  removeFrameLoadListener = () => { iframe?.removeEventListener('load', frameLoaded); removeFrameInteractions?.(); };
  (window as any).allbyteRequestExit = () => exitCallback?.();
  (window as any).allbyteRequestExport = () => void downloadSavesFile();
  // Synchronous call preserves browser activation when Godot forwards a gesture.
  (window as any).allbyteRequestImport = () => {
    trace('import_invoked', { activation: typeof navigator !== 'undefined' ? navigator.userActivation?.isActive : undefined });
    try {
      requireProtocol();
      if (busy || isNativeFilePromptActive() || unknownImportId) throw Error('A save transfer is already pending.');
      if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.isActive) throw Error('The browser needs a recent keyboard, mouse or touch action to open the file chooser.');
      if (!nativePrompt) throw Error('The file chooser is unavailable.');
      nativePrompt.open();
      trace('chooser_accepted');
      return true;
    } catch (e) {
      // Record WHY. Every refusal above throws a distinct message, and without
      // it a refused import is indistinguishable from one that never arrived.
      trace('chooser_refused', { reason: (e as Error).message });
      reportTransfer('error', (e as Error).message); return false;
    }
  };
  // Structured read-out of the trace ring for a driver that wants the full
  // record rather than scraped console lines: window.allbyteSaveTrace().
  if (import.meta.env.DEV) (window as any).allbyteSaveTrace = () => traceEntries.slice();
  if (import.meta.env.DEV) (window as any).__saves_test = {
    store: saves, getCurrent: () => saves.current, getSyncStatus: () => saves.syncStatus,
    getMaxSaveSlots: () => saves.maxSaveSlots, getProtocolVersion: () => saves.protocolVersion,
    getLastLoadResult: () => saves.lastLoadResult, getErrorMessage: () => saves.errorMessage,
    isGameReady: () => saves.gameReady, getPreReadyQueueLength: () => 0,
    getIsSyncTier: () => false, sentMessages: [],
    setTestTier: (tier: string) => {
      auth.currentUser = auth.currentUser ? { ...auth.currentUser, tier } :
        { userId: 'test', email: 'test@allbyte.studio', username: 'test', tier,
          stripeCustomerId: null, notificationPreferences: null } as any;
    },
  };
}
export function teardownSaveBridge() {
  trace('bridge_teardown');
  stopTraceListeners?.(); stopTraceListeners = null;
  nativePrompt?.destroy();
  nativePrompt = null;
  removeFrameLoadListener?.();
  removeFrameLoadListener = null;
  generation++; mutation++; requests.cancel();
  iframeRef = null; exitCallback = null; sessionId = ''; busy = false;
  unknownImportId = '';
  saves.gameReady = false; saves.protocolVersion = null; saves.maxSaveSlots = null;
  saves.saveCapabilities = {};
  saves.lastLoadResult = null; saves.current = { saves: {}, options: '', keymapping: '' };
  saves.syncStatus = 'idle'; saves.lastSyncedAt = null; saves.errorMessage = null;
  if (typeof window === 'undefined') return;
  window.removeEventListener('message', handleGameMessage);
  delete (window as any).allbyteRequestExit;
  delete (window as any).allbyteRequestExport;
  delete (window as any).allbyteRequestImport;
  if (import.meta.env.DEV) { delete (window as any).__saves_test; delete (window as any).allbyteSaveTrace; }
}
function handleGameMessage(e: MessageEvent) {
  const data = e.data;
  if (!iframeRef || !data || typeof data !== 'object' || typeof data.type !== 'string') return;
  const origin = new URL(iframeRef.src || window.location.href, window.location.href).origin;
  const bypass = import.meta.env.DEV && (window as any).__saves_test_skip_source_check === true;
  if (!bypass && (e.source !== iframeRef.contentWindow || e.origin !== origin)) {
    // Do not copy untrusted payload identifiers into diagnostics.
    trace('message_rejected', { rejection: e.source !== iframeRef.contentWindow ? 'source' : 'origin' }); return;
  }
  const saveMessage = ['allbyte:all-saves', 'allbyte:load-complete', 'allbyte:load-pending', 'allbyte:save-changed'].includes(data.type);
  if (saveMessage && (!sessionId || data.sessionId !== sessionId || data.protocolVersion !== 2)) {
    traceMessage('message_rejected', data, 'session_or_protocol'); return;
  }
  traceMessage('message_received', data);
  if (requests.accept(data)) { traceMessage('request_matched', data); return; }
  switch (data.type) {
    case 'allbyte:request-exit': exitCallback?.(); return;
    case 'allbyte:request-export-saves': void downloadSavesFile(); return;
    case 'allbyte:request-import-saves': (window as any).allbyteRequestImport?.(); return;
    case 'allbyte:ready': {
      if (typeof data.sessionId !== 'string' || !data.sessionId || data.protocolVersion !== 2 ||
          !Number.isInteger(data.maxSaveSlots) || data.maxSaveSlots < 1 || data.maxSaveSlots > 12) return;
      if (sessionId === data.sessionId && saves.gameReady) return;
      // Retire a prior session's chooser before accepting another game's files.
      if (sessionId && sessionId !== data.sessionId) {
        nativePrompt?.destroy();
        nativePrompt = new NativeFilePrompt(window, document, handleNativePrompt,
          file => { trace('file_selected', { bytes: file.size }); void uploadSavesFile(file); }, handleNativeSettled);
        try { if (iframeRef.contentWindow) nativePrompt.watchInteractions(iframeRef.contentWindow); } catch {}
      }
      requests.cancel(); generation++; sessionId = data.sessionId; busy = false;
      unknownImportId = '';
      saves.gameReady = true; saves.protocolVersion = 2; saves.maxSaveSlots = data.maxSaveSlots;
      saves.saveCapabilities = data.saveCapabilities ?? {};
      saves.current = { saves: {}, options: '', keymapping: '' };
      broadcastSyncStatus(); broadcastAccount();
      {
        const c = context();
        void freshSnapshot().then(snapshot => { if (valid(c)) saves.current = snapshot; })
          .catch(e => { if (valid(c)) reportTransfer('error', e.message); });
      }
      return;
    }
    case 'allbyte:save-changed': {
      if (!Number.isInteger(data.slotId) || data.slotId < 1 || data.slotId > (saves.maxSaveSlots ?? 12) || typeof data.data !== 'string') return;
      mutation++; saves.current.saves[`slot_${data.slotId}`] = data.data;
      return;
    }
    case 'allbyte:load-complete':
      if (unknownImportId && data.requestId === unknownImportId && unknownImportAccount === (auth.currentUser?.userId ?? '')) {
        try {
          if (data.ok) saves.current = parseSnapshot(data.snapshot, saves.maxSaveSlots ?? 12);
          unknownImportId = '';
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
  catch (e) { trace('import_ack_unresolved', { requestId }); if (sameSession(c) && opts.source === 'import') unknownImportId = requestId; throw e; }
  if (!(opts.source === 'import' ? sameSession(c) : valid(c))) throw Error('Game or account changed during save transfer');
  if (typeof result.ok !== 'boolean') throw Error('Import result unknown: malformed game acknowledgment.');
  saves.lastLoadResult = { acceptedSlots: result.acceptedSlots ?? [], rejectedSlots: result.rejectedSlots ?? [] };
  if (!result.ok) {
    if (opts.source === 'import') unknownImportId = '';
    if (result.reason === 'empty_import') throw Error('This backup contains no saved game slots to import. Settings and controls are not imported.');
    throw Error(result.reason === 'cancelled' ? 'Import cancelled' : `Import failed: ${result.reason || 'unknown error'}`);
  }
  saves.current = parseSnapshot(result.snapshot, saves.maxSaveSlots ?? 12);
  if (opts.source === 'import') unknownImportId = '';
  return result;
}
export async function downloadSavesFile() {
  if (busy || isNativeFilePromptActive() || unknownImportId) return reportTransfer('error', 'A save transfer is already pending.');
  const c = context(); busy = true;
  try {
    const snapshot = await freshSnapshot();
    if (!valid(c)) throw Error('Game or account changed during export');
    const slotCount = Object.keys(snapshot.saves).length;
    trace('export_snapshot', { slotCount });
    if (slotCount === 0) throw Error('No saved game slots to export. Save your game in a numbered slot first; autosave and quicksave are not included.');
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
  const c = context();
  try {
    requireProtocol();
    if (file.size > MAX_TRANSFER_BYTES) throw Error('Save file is too large');
    const snapshot = parseBackup(await file.text(), saves.maxSaveSlots ?? 12);
    trace('backup_validated', { slotCount: Object.keys(snapshot.saves).length });
    if (Object.keys(snapshot.saves).length === 0) throw Error('This backup contains no saved game slots to import. Settings and controls are not imported.');
    if (!valid(c)) throw Error('Game or account changed during import');
    // The game confirms affected slots before committing. Cloud state is irrelevant.
    await loadSavesIntoGame({ saves: snapshot.saves }, { source: 'import' });
    return null;
  } catch (e) {
    const message = (e as Error).message;
    if (c.generation === generation) reportTransfer(message === 'Import cancelled' ? 'cancelled' : 'error', message);
    return message === 'Import cancelled' ? null : message;
  } finally { if (c.generation === generation) busy = false; }
}
function broadcastSyncStatus() {
  if (saves.gameReady) postToGame({ type: 'allbyte:sync-status', status: saves.syncStatus,
    lastSyncedAt: saves.lastSyncedAt, errorMessage: saves.errorMessage });
}
function broadcastAccount() {
  const u = auth.currentUser;
  postToGame({ type: 'allbyte:account', username: u?.username ?? null, tier: u?.tier ?? 'default', cloudSaves: false });
}
// Compatibility entry points: cloud synchronization is intentionally disabled.
export async function syncFromServer(): Promise<void> {}
export async function syncToServerNow(): Promise<boolean> { return false; }
