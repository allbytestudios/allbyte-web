import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeFilePrompt, installGameVisibility, restoreGameFocus } from '../src/lib/native-file-prompt.ts';

test('picker return restores canvas focus across iframe boundary without stealing other controls', () => {
  const doc = {visibilityState:'visible', hasFocus:()=>true, body:{}, documentElement:{}};
  const game = {body:{}, documentElement:{}, hasFocus:()=>true};
  const canvas = {focus:()=>{ game.activeElement=canvas; }};
  game.getElementById=()=>canvas; game.activeElement=game.body;
  const frame = {contentDocument:game, focus:()=>{doc.activeElement=frame;}};
  doc.activeElement=doc.body;
  assert.equal(restoreGameFocus(doc,frame),true);
  doc.activeElement={}; assert.equal(restoreGameFocus(doc,frame),false);
  doc.activeElement=doc.body; game.activeElement={}; assert.equal(restoreGameFocus(doc,frame),false);
  game.activeElement=game.body; doc.visibilityState='hidden'; assert.equal(restoreGameFocus(doc,frame),false);
  doc.visibilityState='visible'; doc.hasFocus=()=>false; assert.equal(restoreGameFocus(doc,frame),false);
});

class Target {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, props = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...props }); }
}
function fixture(onEvent = () => {}, onSettled = () => {}) {
  const win = new Target(); const frame = new Target(); const doc = new Target();
  doc.visibilityState = 'visible'; doc.focused = true; doc.hasFocus = () => doc.focused;
  const inputs = []; const events = []; const files = [];
  doc.body = { appendChild() {} };
  doc.createElement = () => {
    const input = new Target(); input.style = {}; input.files = [];
    input.click = () => {}; input.remove = () => {
      input.removed = true;
      if (doc.activeElement === input) doc.activeElement = doc.body;
    };
    inputs.push(input); return input;
  };
  const prompt = new NativeFilePrompt(win, doc, e => { events.push(e); onEvent(e); }, file => files.push(file), onSettled);
  prompt.watchInteractions(frame);
  return { win, frame, doc, prompt, inputs, events, files };
}

test('selected file closes the handoff and resets identical-file selection', () => {
  const h = fixture(); h.prompt.open();
  const input = h.inputs[0]; const file = new File(['{}'], 'save.json');
  input.files = [file]; input.fire('change');
  assert.equal(h.prompt.active, false); assert.equal(input.value, ''); assert(input.removed);
  assert.deepEqual(h.files, [file]);
  assert.deepEqual(h.events.map(e => [e.phase, e.outcome]), [['opening', 'pending'], ['returned', 'selected']]);
  h.prompt.open(); h.inputs[1].files = [file]; h.inputs[1].fire('change');
  assert.equal(h.files.length, 2);
  assert.notEqual(h.events[0].promptId, h.events[2].promptId); h.prompt.destroy();
});

test('focus can return before change without dropping a selected file', () => {
  const h = fixture(); h.prompt.open(); h.doc.focused = false; h.win.fire('blur');
  h.doc.focused = true; h.win.fire('focus');
  assert.equal(h.prompt.active, true);
  assert.equal(h.events.at(-1).outcome, 'returned');
  h.inputs[0].files = [new File(['{}'], 'save.json')]; h.inputs[0].fire('change');
  assert.equal(h.files.length, 1);
  assert.equal(h.events.filter(e => e.phase === 'returned').length, 1); h.prompt.destroy();
});

test('early return retries guarded focus after terminal input removal exactly once', () => {
  for (const terminal of ['change', 'cancel', 'error']) {
    const attempts = []; let focused = false;
    const h = fixture(e => {
      if (e.phase === 'returned') attempts.push(restoreGameFocus(h.doc, frame));
    }, () => attempts.push(restoreGameFocus(h.doc, frame)));
    const game = {body:{}, documentElement:{}, hasFocus:()=>focused};
    const canvas = {focus:()=>{ game.activeElement=canvas; focused=true; }};
    game.getElementById=()=>canvas; game.activeElement=game.body;
    const frame = {contentDocument:game, focus:()=>{h.doc.activeElement=frame;}};
    const create = h.doc.createElement;
    h.doc.createElement = () => {
      const input=create();
      input.click=()=>{
        h.doc.activeElement=input; h.doc.focused=false; h.win.fire('blur');
        h.doc.focused=true; h.win.fire('focus');
        if (terminal === 'error') throw Error('picker failed');
      };
      return input;
    };
    if (terminal === 'error') assert.throws(()=>h.prompt.open(), /picker failed/);
    else {
      h.prompt.open(); assert.deepEqual(attempts,[false]);
      if (terminal === 'change') h.inputs[0].files=[new File(['{}'],'save.json')];
      h.inputs[0].fire(terminal);
    }
    assert.deepEqual(attempts,[false,true]);
    assert.equal(h.events.filter(e=>e.phase==='returned').length,1);
    assert.equal(h.files.length,terminal === 'change' ? 1 : 0);
    h.prompt.destroy(); assert.equal(attempts.length,2);
  }
});

test('terminal recovery preserves other controls and hidden or unfocused windows', () => {
  for (const protectedState of ['host-control','game-control','hidden','unfocused']) {
    let settled=0; let focusCalls=0;
    const h=fixture(()=>{},()=>{settled++; restoreGameFocus(h.doc,frame);});
    const game={body:{},documentElement:{},hasFocus:()=>false};
    const canvas={focus:()=>{focusCalls++;}};
    game.getElementById=()=>canvas; game.activeElement=game.body;
    const frame={contentDocument:game,focus:()=>{focusCalls++;}};
    h.prompt.open(); h.doc.activeElement=h.inputs[0];
    if (protectedState==='host-control') h.doc.activeElement={};
    if (protectedState==='game-control') game.activeElement={};
    if (protectedState==='hidden') h.doc.visibilityState='hidden';
    if (protectedState==='unfocused') h.doc.focused=false;
    h.inputs[0].fire('cancel');
    assert.equal(settled,1); assert.equal(focusCalls,0); h.prompt.destroy();
  }
});

test('destroying a pending chooser never invokes terminal focus recovery', () => {
  let recoveries=0; const h=fixture(()=>{},()=>recoveries++);
  h.prompt.open(); h.prompt.destroy(); assert.equal(recoveries,0);
});

test('silent cancellation recovers on real iframe interaction and rejects stale file callbacks', () => {
  const h = fixture(); h.prompt.open(); const retired = h.inputs[0];
  h.frame.fire('pointerdown', { isTrusted: true });
  assert.equal(h.prompt.active, false);
  assert.equal(h.events.at(-1).outcome, 'returned');
  h.prompt.open(); retired.files = [new File(['{}'], 'old.json')]; retired.fire('change');
  assert.equal(h.files.length, 0); assert.equal(h.prompt.active, true); h.prompt.destroy();
});

test('synthetic/repeating input and hidden focus cannot unlock a chooser', () => {
  const h = fixture(); h.prompt.open();
  h.win.fire('pointerdown', { isTrusted: false });
  h.frame.fire('keydown', { isTrusted: true, repeat: true });
  h.doc.visibilityState = 'hidden'; h.doc.fire('visibilitychange'); h.win.fire('focus');
  h.frame.fire('pointerdown', { isTrusted: true });
  assert.equal(h.prompt.active, true); assert.equal(h.events.length, 1); h.prompt.destroy();
});

test('duplicate requests do not clear pending state; cancellation enables retry', () => {
  const h = fixture(); h.prompt.open();
  assert.throws(() => h.prompt.open(), /already pending/);
  assert.equal(h.prompt.active, true); assert.equal(h.inputs.length, 1);
  h.inputs[0].fire('cancel');
  assert.equal(h.prompt.active, false); assert.equal(h.events.at(-1).outcome, 'cancelled');
  h.prompt.open(); assert.equal(h.inputs.length, 2); h.prompt.destroy();
});

test('chooser invocation failure restores handoff and allows retry', () => {
  const h = fixture(); const create = h.doc.createElement;
  h.doc.createElement = () => { const input = create(); input.click = () => { throw Error('blocked'); }; return input; };
  assert.throws(() => h.prompt.open(), /blocked/);
  assert.equal(h.prompt.active, false); assert.equal(h.events.at(-1).outcome, 'error');
  h.doc.createElement = create; h.prompt.open(); h.prompt.destroy();
});

test('native fullscreen-exit classification survives terminal events until real input', () => {
  const h = fixture(); h.prompt.open(); h.inputs[0].fire('cancel');
  assert.equal(h.prompt.recovering, true); // a queued fullscreenchange is still native
  h.win.fire('pointerdown', { isTrusted: true });
  assert.equal(h.prompt.recovering, false); // subsequent user exits remain deliberate
  h.prompt.destroy();
});

test('destroy retires the input and all listeners', () => {
  const h = fixture(); h.prompt.open(); h.prompt.destroy(); const count = h.events.length;
  h.inputs[0].files = [new File(['{}'], 'stale.json')]; h.inputs[0].fire('change');
  h.win.fire('focus'); h.frame.fire('pointerdown', { isTrusted: true });
  assert.equal(h.files.length, 0); assert.equal(h.events.length, count);
});

test('desktop blur/focus balances pause without visibilitychange; iframe focus is not a pause', () => {
  const h = fixture(); const seen = []; const stop = installGameVisibility(h.win, h.doc, v => seen.push(v));
  h.win.fire('blur'); assert.deepEqual(seen, []); // page still owns focus in iframe
  h.doc.focused = false; h.win.fire('blur'); h.win.fire('blur');
  h.doc.focused = true; h.win.fire('focus'); h.win.fire('focus');
  assert.deepEqual(seen, [false, true]); stop(); h.prompt.destroy();
});

test('visible but unfocused lifecycle events cannot undo a blur pause', () => {
  const h = fixture(); const seen = []; const stop = installGameVisibility(h.win, h.doc, v => seen.push(v));
  h.doc.focused = false; h.win.fire('blur');
  h.win.fire('pageshow'); h.doc.fire('visibilitychange'); h.win.fire('focus'); stop.refresh();
  assert.deepEqual(seen, [false]);
  h.doc.focused = true; h.win.fire('focus');
  assert.deepEqual(seen, [false, true]); stop(); h.prompt.destroy();
});

test('focus returning directly to the iframe balances host pause without parent focus', () => {
  const h = fixture(); const seen = []; const stop = installGameVisibility(h.win, h.doc, v => seen.push(v));
  const unwatch = stop.watch(h.frame);
  h.doc.focused = false; h.win.fire('blur');
  h.doc.focused = true; h.frame.fire('focus');
  h.frame.fire('pointerdown', { isTrusted: true });
  assert.deepEqual(seen, [false, true]);
  h.doc.focused = false; h.win.fire('blur');
  unwatch(); h.doc.focused = true; h.frame.fire('focus');
  assert.deepEqual(seen, [false, true, false]); stop(); h.prompt.destroy();
});

test('frame input cannot resume hidden or unfocused pages and listeners retire', () => {
  const h = fixture(); const seen = []; const stop = installGameVisibility(h.win, h.doc, v => seen.push(v));
  stop.watch(h.frame);
  h.doc.focused = false; h.win.fire('blur');
  h.frame.fire('focus'); h.frame.fire('pointerdown', { isTrusted: true });
  h.doc.focused = true; h.doc.visibilityState = 'hidden'; h.frame.fire('focus');
  h.frame.fire('keydown', { isTrusted: true });
  h.doc.visibilityState = 'visible'; h.frame.fire('pointerdown', { isTrusted: false });
  h.frame.fire('keydown', { isTrusted: true, repeat: true });
  assert.deepEqual(seen, [false]);
  h.frame.fire('keydown', { isTrusted: true, repeat: false });
  assert.deepEqual(seen, [false, true]);
  stop(); h.doc.focused = false; h.win.fire('blur');
  assert.deepEqual(seen, [false, true]); h.prompt.destroy();
});

test('hidden focus cannot resume; pageshow and explicit chooser return can recover', () => {
  const h = fixture(); const seen = []; const stop = installGameVisibility(h.win, h.doc, v => seen.push(v));
  h.doc.visibilityState = 'hidden'; h.doc.fire('visibilitychange'); h.win.fire('focus'); stop.refresh();
  assert.deepEqual(seen, [false]);
  h.doc.visibilityState = 'visible'; h.win.fire('pageshow');
  h.doc.focused = false; h.win.fire('blur'); h.doc.focused = true; stop.refresh();
  assert.deepEqual(seen, [false, true, false, true]);
  stop(); h.win.fire('pagehide'); assert.equal(seen.length, 4); h.prompt.destroy();
});
