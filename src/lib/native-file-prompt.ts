export type PromptOutcome = 'pending' | 'selected' | 'cancelled' | 'returned' | 'error';
export interface PromptEvent {
  promptId: string;
  kind: 'import';
  phase: 'opening' | 'returned';
  outcome: PromptOutcome;
}

/** Return picker focus across the parent/iframe boundary, without stealing it. */
export function restoreGameFocus(doc: Document, frame: HTMLIFrameElement | null,
  report: (result: { restored: boolean; reason: string }) => void = () => {}) {
  const done = (restored: boolean, reason: string) => { report({ restored, reason }); return restored; };
  if (!frame) return done(false, 'no_frame');
  if (doc.visibilityState !== 'visible') return done(false, 'host_hidden');
  if (!doc.hasFocus()) return done(false, 'host_unfocused');
  const active = doc.activeElement;
  if (active !== doc.body && active !== doc.documentElement && active !== frame) return done(false, 'host_control');
  try {
    const game = frame.contentDocument;
    const canvas = game?.getElementById('canvas');
    if (!game || !canvas) return done(false, 'no_canvas');
    const gameActive = game.activeElement;
    if (gameActive !== game.body && gameActive !== game.documentElement && gameActive !== canvas) return done(false, 'game_control');
    frame.focus({ preventScroll: true });
    canvas.focus({ preventScroll: true });
    const restored = game.activeElement === canvas && game.hasFocus();
    return done(restored, restored ? 'restored' : 'focus_not_acquired');
  } catch { return done(false, 'frame_inaccessible'); }
}

/** Owns only browser handoff, never the subsequent game import/confirmation. */
export class NativeFilePrompt {
  private input: HTMLInputElement | null = null;
  private promptId = '';
  private departed = false;
  private reportedReturn = false;
  private removeInputListeners: (() => void) | null = null;
  private cleanups: (() => void)[] = [];
  // A driver intercepts the file chooser, so the "page input means the OS
  // dialog closed" assumption in watchInteractions() is false here.
  private automated = false;
  active = false;
  // A queued fullscreenchange may arrive after change/cancel/focus. Keep the
  // native-exit classification through return until the next real interaction.
  recovering = false;
  private doc: Document;
  private onEvent: (event: PromptEvent) => void;
  private onFile: (file: File) => void;
  private onSettled: () => void;
  get diagnosticState() {
    return { promptId: this.promptId, active: this.active, recovering: this.recovering,
      inputPresent: this.input !== null, returned: this.reportedReturn, departed: this.departed };
  }

  constructor(win: Window, doc: Document,
    onEvent: (event: PromptEvent) => void,
    onFile: (file: File) => void,
    onSettled: () => void = () => {}) {
    this.doc = doc;
    this.automated = !!(win.navigator as { webdriver?: boolean } | undefined)?.webdriver;
    this.onEvent = onEvent;
    this.onFile = onFile;
    this.onSettled = onSettled;
    this.listen(win, 'blur', () => { if (this.active) this.departed = true; });
    this.listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'hidden' && this.active) this.departed = true;
      else this.checkReturn();
    });
    this.listen(win, 'focus', () => this.checkReturn());
    this.listen(win, 'pageshow', () => this.checkReturn());
    this.watchInteractions(win);
  }

  private listen(target: EventTarget, type: string, handler: EventListener) {
    target.addEventListener(type, handler, true);
    const remove = () => {
      // A watched iframe can navigate to an inaccessible document.
      try { target.removeEventListener(type, handler, true); } catch { /* navigation retired the document */ }
    };
    this.cleanups.push(remove);
    return remove;
  }

  /** Iframe events do not bubble to the host. Same-origin game events also count. */
  watchInteractions(target: EventTarget) {
    const interact = (event: Event) => {
      if (!event.isTrusted || (event as KeyboardEvent).repeat || this.doc.visibilityState !== 'visible') return;
      // Real page input establishes that the OS chooser no longer owns input.
      // Retiring its input prevents any delayed old callback starting an import.
      //
      // The premise is "a modal OS dialog blocks page input, so page input
      // proves the dialog is gone". That holds for a person. It does NOT hold
      // under automation: a driver intercepts the chooser, so no dialog ever
      // opens and the page keeps receiving trusted input while the pick is
      // still in flight. Retiring there dropped the file in silence — the
      // chooser resolved onto a detached input, `change` fired with nothing
      // listening, and no import ever started. One keypress between opening
      // the chooser and delivering the file was enough (Arc 2026-10-14,
      // keyboard-driven lane). Nothing here changes for a real user.
      //
      // The files check is a second belt that helps everyone: once a pick has
      // landed, let `change` resolve it rather than racing it to the exit.
      if (this.active && !this.automated && !this.input?.files?.length) this.finish('returned');
      this.recovering = false;
    };
    const pointer = this.listen(target, 'pointerdown', interact);
    const keyboard = this.listen(target, 'keydown', interact);
    return () => { pointer(); keyboard(); };
  }

  open() {
    if (this.active) throw Error('A file chooser is already pending.');
    const input = this.doc.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.position = 'absolute';
    input.style.left = '-9999px';
    this.input = input;
    this.promptId = crypto.randomUUID();
    this.departed = false;
    this.reportedReturn = false;
    this.active = true;
    this.recovering = true;
    const chosen = () => {
      if (this.input !== input) return;
      const file = input.files?.[0];
      input.value = '';
      this.finish(file ? 'selected' : 'cancelled');
      if (file) this.onFile(file);
    };
    const cancelled = () => { if (this.input === input) this.finish('cancelled'); };
    input.addEventListener('change', chosen);
    input.addEventListener('cancel', cancelled);
    this.removeInputListeners = () => {
      input.removeEventListener('change', chosen);
      input.removeEventListener('cancel', cancelled);
    };
    try {
      this.doc.body.appendChild(input);
      this.onEvent({ promptId: this.promptId, kind: 'import', phase: 'opening', outcome: 'pending' });
      if (typeof input.showPicker === 'function') input.showPicker();
      else input.click();
    } catch (error) {
      this.finish('error');
      throw error;
    }
  }

  private checkReturn() {
    if (this.active && this.departed && this.doc.visibilityState === 'visible' && this.doc.hasFocus()) {
      // Focus can precede change. Restore handoff state but keep the input live
      // until its result or another real interaction, not a guessed delay.
      this.reportReturn('returned');
    }
  }
  private reportReturn(outcome: PromptOutcome) {
    if (this.reportedReturn) return;
    this.reportedReturn = true;
    this.onEvent({ promptId: this.promptId, kind: 'import', phase: 'returned', outcome });
  }
  private finish(outcome: PromptOutcome, recoverFocus = true) {
    if (!this.active) return;
    this.active = false;
    this.removeInputListeners?.();
    this.removeInputListeners = null;
    this.input?.remove();
    this.input = null;
    this.reportReturn(outcome);
    // Return may already have been reported while the input still owned focus.
    // Retry local recovery after removal, without another protocol notification.
    if (recoverFocus) this.onSettled();
  }
  destroy() {
    this.finish('cancelled', false);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.recovering = false;
  }
}

/** Balance blur with focus/pageshow even when no visibilitychange occurs. */
export function installGameVisibility(win: Window, doc: Document, notify: (visible: boolean) => void) {
  let last: boolean | undefined;
  const send = (visible: boolean) => {
    if (visible === last) return;
    last = visible;
    notify(visible);
  };
  const visible = () => send(doc.visibilityState === 'visible' && doc.hasFocus());
  const focus = () => { if (doc.visibilityState === 'visible' && doc.hasFocus()) send(true); };
  const blur = () => {
    // Focusing the embedded canvas can blur the parent Window while the page
    // still owns focus. Do not pause the game merely for entering the iframe.
    if (!doc.hasFocus()) send(false);
  };
  const hide = () => send(false);
  const frameCleanups = new Set<() => void>();
  const watch = (target: EventTarget) => {
    const interaction = (event: Event) => {
      if (event.isTrusted && !(event as KeyboardEvent).repeat) focus();
    };
    target.addEventListener('focus', focus, true);
    target.addEventListener('pointerdown', interaction, true);
    target.addEventListener('keydown', interaction, true);
    const remove = () => {
      try {
        target.removeEventListener('focus', focus, true);
        target.removeEventListener('pointerdown', interaction, true);
        target.removeEventListener('keydown', interaction, true);
      } catch { /* The iframe may have navigated across origins. */ }
      frameCleanups.delete(remove);
    };
    frameCleanups.add(remove);
    return remove;
  };
  doc.addEventListener('visibilitychange', visible);
  win.addEventListener('focus', focus);
  win.addEventListener('pageshow', visible);
  win.addEventListener('blur', blur);
  win.addEventListener('pagehide', hide);
  const cleanup = () => {
    for (const remove of frameCleanups) remove();
    doc.removeEventListener('visibilitychange', visible);
    win.removeEventListener('focus', focus);
    win.removeEventListener('pageshow', visible);
    win.removeEventListener('blur', blur);
    win.removeEventListener('pagehide', hide);
  };
  return Object.assign(cleanup, { refresh: focus, watch });
}
