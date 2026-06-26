<script lang="ts">
  /**
   * Touch-only virtual gamepad overlay for the /play/ iframe.
   *
   * Sits in the letterbox bars on phones — a traditional cross/plus d-pad in
   * the left bar, 4 PlayStation-style face buttons (Triangle/Square/Circle/
   * Cross, drawn as inline SVG) in the right. The internal button identities
   * are still A/B/X/Y for the key mapping; only the glyphs are PS symbols, and
   * the positions follow the PS convention (Cross=confirm bottom, Circle=cancel
   * right). The game canvas is unchanged at 1.38:1 aspect, so on modern phone
   * screens in landscape the bars are 50-150pt wide, plenty for thumb buttons.
   *
   * Input is translated to synthetic KeyboardEvents dispatched at the iframe's
   * contentWindow. The game's existing input map (project.godot [input]) maps
   * these to ui_left/right/up/down + ui_accept/cancel/select/secondary —
   * no game-side changes required for movement+confirm.
   *
   * Visibility: shown only when the viewport supports coarse pointers AND is
   * narrow enough that the controls fit in the letterbox bars without
   * overlapping the game canvas. Desktop never renders the overlay.
   *
   * v1 scope is d-pad + 4 buttons only. Two-finger pan/zoom for camera is
   * deferred — to be wired alongside the same touch-handling layer when
   * a real touch design lands game-side.
   */
  interface Props {
    /** The play iframe whose contentWindow receives synthetic key events. */
    iframe: HTMLIFrameElement | null;
  }

  let { iframe }: Props = $props();

  type DpadDir = "up" | "down" | "left" | "right";
  type FaceBtn = "A" | "B" | "X" | "Y";

  // Key mapping derived from project.godot [input] section:
  //   ui_left/move_left  ← ArrowLeft  (also physical KeyA)
  //   ui_right/move_right ← ArrowRight (also physical KeyD)
  //   ui_up/move_up      ← ArrowUp    (also physical KeyW)
  //   ui_down/move_down  ← ArrowDown  (also physical KeyS)
  //   ui_accept          ← Enter
  //   ui_cancel          ← Escape
  //   ui_select          ← Space (also KeyE / Tab)
  //   ui_secondary       ← KeyE (only physical scancode in events list)
  const DPAD_KEYS: Record<DpadDir, { key: string; code: string; keyCode: number }> = {
    up:    { key: "ArrowUp",    code: "ArrowUp",    keyCode: 38 },
    down:  { key: "ArrowDown",  code: "ArrowDown",  keyCode: 40 },
    left:  { key: "ArrowLeft",  code: "ArrowLeft",  keyCode: 37 },
    right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  };
  const FACE_KEYS: Record<FaceBtn, { key: string; code: string; keyCode: number; label: string }> = {
    A: { key: "Enter",  code: "Enter",     keyCode: 13, label: "A" },
    B: { key: "Escape", code: "Escape",    keyCode: 27, label: "B" },
    X: { key: " ",      code: "Space",     keyCode: 32, label: "X" },
    Y: { key: "e",      code: "KeyE",      keyCode: 69, label: "Y" },
  };

  /** Track which buttons are currently held so we don't double-fire keydown
   *  if a touch lingers or multitouch jitters. */
  const held = new Set<string>();

  /** Set once any touch is seen. The mouse handlers below exist only for
   *  desktop dev-testing; on a real touch device a tap can synthesize a
   *  mousedown AFTER touchend, which would re-press the same direction and
   *  move a second tile from one press. Once we've seen touch, the mouse
   *  path stands down for good. */
  let touchSeen = false;

  // === D-pad gesture state ===
  // Reactive flags so the visual arrows highlight what the engine sees.
  let dpadUp = $state(false);
  let dpadDown = $state(false);
  let dpadLeft = $state(false);
  let dpadRight = $state(false);
  // Which touch identifier (if any) is currently driving the d-pad. Lets us
  // ignore touches that landed on other elements and only update from the
  // one finger that's on the d-pad zone.
  let dpadTouchId: number | null = null;

  function dispatchKey(type: "keydown" | "keyup", k: { key: string; code: string; keyCode: number }) {
    if (!iframe || !iframe.contentWindow) return;

    // Godot's Emscripten-built web export registers keyboard callbacks
    // through `registerKeyEventCallback`, which typically attaches to the
    // iframe's `document` — NOT its `window`. Dispatching at the canvas
    // and letting the event bubble up covers all three possible listener
    // locations (canvas → document → window) with one dispatch.
    //
    // Same-origin lets us reach into the iframe's DOM. If contentDocument
    // is unavailable for any reason (rare race during boot), fall back to
    // the window so we at least try.
    let target: EventTarget | null = null;
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        target = doc.querySelector("canvas") ?? doc;
      }
    } catch {
      /* document inaccessible for some reason — keep target null */
    }
    if (!target) target = iframe.contentWindow;

    const ev = new KeyboardEvent(type, {
      key: k.key,
      code: k.code,
      // keyCode/which are deprecated but Emscripten's keyboard handler
      // still reads them — pass for compatibility.
      keyCode: k.keyCode,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
  }

  function press(id: string, mapping: { key: string; code: string; keyCode: number }) {
    if (held.has(id)) return;
    held.add(id);
    dispatchKey("keydown", mapping);
  }

  function release(id: string, mapping: { key: string; code: string; keyCode: number }) {
    if (!held.has(id)) return;
    held.delete(id);
    dispatchKey("keyup", mapping);
  }

  // === D-pad handling ===
  //
  // The d-pad is one touch zone, not four buttons. A finger anywhere in the
  // zone resolves to a direction via the angle from the zone center, which
  // gives us two things real-controller d-pads have but our old per-button
  // implementation didn't:
  //
  //   1. Diagonals from a single finger (NE = up + right held simultaneously).
  //   2. Sliding between directions without lifting (touchmove rewrites the
  //      held set; old direction releases, new direction presses).
  //
  // Face buttons stay discrete — they're momentary inputs and the owner said the
  // per-button feel is fine there.

  /** Update the held-direction set based on touch position relative to the
   *  zone center. Pure side-effect function: diffs against the current
   *  $state booleans and fires keydown/keyup for the deltas. */
  function updateDpadFromOffset(dx: number, dy: number) {
    // Deadzone in pixels. Below this, no direction is held — lets the user
    // touch the center and slide outward without spurious presses while
    // their finger is near the middle.
    const DEADZONE = 14;
    const dist = Math.hypot(dx, dy);

    let nUp = false, nDown = false, nLeft = false, nRight = false;
    if (dist >= DEADZONE) {
      // Cardinal-only via dominant axis: the d-pad is drawn as a traditional
      // cross (4 arms) and movement is grid-based, so a tap resolves to exactly
      // ONE direction — the axis with the larger offset wins. (Previously an
      // 8-sector angle map also fired the two adjacent cardinals in the
      // diagonal sectors, so an off-axis tap on the cross — or a thumb rolling
      // slightly off-axis mid-press — sent up+right and moved two tiles: the
      // "2 buttons from one d-pad press" bug.) Screen y is inverted (+ = down).
      if (Math.abs(dx) >= Math.abs(dy)) {
        if (dx > 0) nRight = true;
        else nLeft = true;
      } else {
        if (dy < 0) nUp = true;
        else nDown = true;
      }
    }

    // Diff current vs new and fire the appropriate key events.
    if (dpadUp && !nUp) release("d-up", DPAD_KEYS.up);
    if (!dpadUp && nUp) press("d-up", DPAD_KEYS.up);
    if (dpadDown && !nDown) release("d-down", DPAD_KEYS.down);
    if (!dpadDown && nDown) press("d-down", DPAD_KEYS.down);
    if (dpadLeft && !nLeft) release("d-left", DPAD_KEYS.left);
    if (!dpadLeft && nLeft) press("d-left", DPAD_KEYS.left);
    if (dpadRight && !nRight) release("d-right", DPAD_KEYS.right);
    if (!dpadRight && nRight) press("d-right", DPAD_KEYS.right);

    dpadUp = nUp;
    dpadDown = nDown;
    dpadLeft = nLeft;
    dpadRight = nRight;
  }

  function getTrackedTouch(e: TouchEvent): Touch | null {
    if (dpadTouchId === null) return null;
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === dpadTouchId) return e.touches[i];
    }
    return null;
  }

  function dpadTouchStart(e: TouchEvent) {
    touchSeen = true;
    e.preventDefault();
    // Adopt the first changed touch as our active finger. Once tracked we
    // ignore other touches on this zone, so a second finger landing here
    // doesn't yank the first finger's tracking.
    if (dpadTouchId === null && e.changedTouches.length > 0) {
      dpadTouchId = e.changedTouches[0].identifier;
    }
    const t = getTrackedTouch(e);
    if (!t) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateDpadFromOffset(
      t.clientX - rect.left - rect.width / 2,
      t.clientY - rect.top - rect.height / 2,
    );
  }

  function dpadTouchMove(e: TouchEvent) {
    if (dpadTouchId === null) return;
    e.preventDefault();
    const t = getTrackedTouch(e);
    if (!t) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateDpadFromOffset(
      t.clientX - rect.left - rect.width / 2,
      t.clientY - rect.top - rect.height / 2,
    );
  }

  function dpadTouchEnd(e: TouchEvent) {
    // Only release if the lifted touch is the one we were tracking.
    let lifted = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === dpadTouchId) {
        lifted = true;
        break;
      }
    }
    if (!lifted) return;
    e.preventDefault();
    dpadTouchId = null;
    updateDpadFromOffset(0, 0); // releases everything
  }

  // Mouse fallback for desktop testing of the gamepad (e.g. browser dev
  // tools in a small-viewport simulation). Simpler than touch — single
  // pointer, follow the mouse while button is held.
  let dpadMouseDown = false;
  function dpadMouseDownH(e: MouseEvent) {
    if (touchSeen) return;
    e.preventDefault();
    dpadMouseDown = true;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateDpadFromOffset(
      e.clientX - rect.left - rect.width / 2,
      e.clientY - rect.top - rect.height / 2,
    );
  }
  function dpadMouseMoveH(e: MouseEvent) {
    if (!dpadMouseDown) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateDpadFromOffset(
      e.clientX - rect.left - rect.width / 2,
      e.clientY - rect.top - rect.height / 2,
    );
  }
  function dpadMouseEndH() {
    if (!dpadMouseDown) return;
    dpadMouseDown = false;
    updateDpadFromOffset(0, 0);
  }

  // === Face button handling ===
  //
  // Mirror of the d-pad zone but exclusive — only one face button held at a
  // time. Lets the user slide from B to A (or anywhere between adjacent
  // buttons) without lifting; the previously-held button releases and the
  // new one presses. the owner's UX call: "I would like to slide between b and a,
  // but we don't want multiple buttons pressed at the same time like d-pad".
  //
  // Direction → button mapping (diamond layout: Y top, A bottom, X left, B
  // right). We use dominant-axis quadrant detection rather than nearest-
  // center distance, so the boundary between two buttons is cleanly the
  // 45° line and slides feel predictable.

  let faceHeld = $state<FaceBtn | null>(null);
  let faceTouchId: number | null = null;

  // Auto-repeat for face buttons. Touch events don't fire while a finger
  // stays still on the screen, so without this a held button only fires
  // one keydown — which means equip → unequip → equip patterns require
  // physically lifting between each tap. Owner spec (2026-06-01): holding
  // should re-trigger after a brief delay, matching keyboard auto-repeat.
  //
  // Delay before first repeat is generous so quick taps don't accidentally
  // repeat. Interval after that is snappy enough for menu navigation
  // without blasting through items. The d-pad doesn't need this because
  // movement uses Input.is_action_pressed (continuous) and the touch
  // layer dispatches via touchmove anyway.
  const FACE_REPEAT_DELAY_MS = 400;
  const FACE_REPEAT_INTERVAL_MS = 200;
  let faceRepeatTimer: ReturnType<typeof setTimeout> | null = null;
  let faceRepeatInterval: ReturnType<typeof setInterval> | null = null;

  function startFaceRepeat(btn: FaceBtn) {
    stopFaceRepeat();
    faceRepeatTimer = setTimeout(() => {
      faceRepeatInterval = setInterval(() => {
        // Re-press: keyup then keydown so the engine sees a clean edge.
        // The held set already has "f-${btn}" so we bypass the
        // press/release helpers (they'd no-op due to the held check).
        dispatchKey("keyup", FACE_KEYS[btn]);
        dispatchKey("keydown", FACE_KEYS[btn]);
      }, FACE_REPEAT_INTERVAL_MS);
    }, FACE_REPEAT_DELAY_MS);
  }

  function stopFaceRepeat() {
    if (faceRepeatTimer) {
      clearTimeout(faceRepeatTimer);
      faceRepeatTimer = null;
    }
    if (faceRepeatInterval) {
      clearInterval(faceRepeatInterval);
      faceRepeatInterval = null;
    }
  }

  function updateFaceFromOffset(dx: number, dy: number) {
    const DEADZONE = 8;
    const dist = Math.hypot(dx, dy);
    let next: FaceBtn | null = null;
    if (dist >= DEADZONE) {
      if (Math.abs(dy) > Math.abs(dx)) {
        next = dy < 0 ? "Y" : "A";
      } else {
        next = dx > 0 ? "B" : "X";
      }
    }
    if (next === faceHeld) return;
    if (faceHeld !== null) release(`f-${faceHeld}`, FACE_KEYS[faceHeld]);
    if (next !== null) press(`f-${next}`, FACE_KEYS[next]);
    faceHeld = next;
    // Manage the auto-repeat timer: start when a button becomes held,
    // stop when it leaves (either to a different button — its own timer
    // restarts — or to nothing on release).
    if (next !== null) {
      startFaceRepeat(next);
    } else {
      stopFaceRepeat();
    }
  }

  function getTrackedFaceTouch(e: TouchEvent): Touch | null {
    if (faceTouchId === null) return null;
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === faceTouchId) return e.touches[i];
    }
    return null;
  }

  function faceTouchStart(e: TouchEvent) {
    touchSeen = true;
    e.preventDefault();
    if (faceTouchId === null && e.changedTouches.length > 0) {
      faceTouchId = e.changedTouches[0].identifier;
    }
    const t = getTrackedFaceTouch(e);
    if (!t) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateFaceFromOffset(
      t.clientX - rect.left - rect.width / 2,
      t.clientY - rect.top - rect.height / 2,
    );
  }

  function faceTouchMove(e: TouchEvent) {
    if (faceTouchId === null) return;
    e.preventDefault();
    const t = getTrackedFaceTouch(e);
    if (!t) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateFaceFromOffset(
      t.clientX - rect.left - rect.width / 2,
      t.clientY - rect.top - rect.height / 2,
    );
  }

  function faceTouchEnd(e: TouchEvent) {
    let lifted = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === faceTouchId) {
        lifted = true;
        break;
      }
    }
    if (!lifted) return;
    e.preventDefault();
    faceTouchId = null;
    updateFaceFromOffset(0, 0);
  }

  // Mouse fallback for desktop testing.
  let faceMouseDown = false;
  function faceMouseDownH(e: MouseEvent) {
    if (touchSeen) return;
    e.preventDefault();
    faceMouseDown = true;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateFaceFromOffset(
      e.clientX - rect.left - rect.width / 2,
      e.clientY - rect.top - rect.height / 2,
    );
  }
  function faceMouseMoveH(e: MouseEvent) {
    if (!faceMouseDown) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    updateFaceFromOffset(
      e.clientX - rect.left - rect.width / 2,
      e.clientY - rect.top - rect.height / 2,
    );
  }
  function faceMouseEndH() {
    if (!faceMouseDown) return;
    faceMouseDown = false;
    updateFaceFromOffset(0, 0);
  }
</script>

<!-- Two zones — left (d-pad) and right (face buttons). Each zone is a single
     touch capture area that handles a finger anywhere inside it, so the
     user can hold a direction and slide to a different one without lifting,
     and hold diagonals on the d-pad with one finger. Container is
     pointer-events:none so touches on the game canvas in the middle still
     reach the iframe; the zones below opt back in. -->
<div class="gamepad-overlay" aria-hidden="false">
  <div
    class="dpad-zone"
    role="group"
    aria-label="Directional pad"
    ontouchstart={dpadTouchStart}
    ontouchmove={dpadTouchMove}
    ontouchend={dpadTouchEnd}
    ontouchcancel={dpadTouchEnd}
    onmousedown={dpadMouseDownH}
    onmousemove={dpadMouseMoveH}
    onmouseup={dpadMouseEndH}
    onmouseleave={dpadMouseEndH}
  >
    <svg class="dpad-svg" viewBox="0 0 100 100" aria-hidden="true">
      <!-- Traditional cross/plus body; each arm fills when that direction
           is the one the engine currently sees (class:active). -->
      <path
        class="dpad-body"
        d="M36,2 L64,2 L64,36 L98,36 L98,64 L64,64 L64,98 L36,98 L36,64 L2,64 L2,36 L36,36 Z"
      />
      <rect class="dpad-arm" class:active={dpadUp}    x="39" y="5"  width="22" height="33" rx="3" />
      <rect class="dpad-arm" class:active={dpadDown}  x="39" y="62" width="22" height="33" rx="3" />
      <rect class="dpad-arm" class:active={dpadLeft}  x="5"  y="39" width="33" height="22" rx="3" />
      <rect class="dpad-arm" class:active={dpadRight} x="62" y="39" width="33" height="22" rx="3" />
      <polygon class="dpad-chevron" points="50,10 44,19 56,19" />
      <polygon class="dpad-chevron" points="50,90 44,81 56,81" />
      <polygon class="dpad-chevron" points="10,50 19,44 19,56" />
      <polygon class="dpad-chevron" points="90,50 81,44 81,56" />
    </svg>
  </div>

  <div
    class="face-zone"
    role="group"
    aria-label="Action buttons"
    ontouchstart={faceTouchStart}
    ontouchmove={faceTouchMove}
    ontouchend={faceTouchEnd}
    ontouchcancel={faceTouchEnd}
    onmousedown={faceMouseDownH}
    onmousemove={faceMouseMoveH}
    onmouseup={faceMouseEndH}
    onmouseleave={faceMouseEndH}
  >
    <span class="face-btn face-y" class:active={faceHeld === "Y"} aria-label="Triangle button (secondary)">
      <svg class="face-icon" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,4 21,20 3,20" /></svg>
    </span>
    <span class="face-btn face-x" class:active={faceHeld === "X"} aria-label="Square button (select)">
      <svg class="face-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
    </span>
    <span class="face-btn face-b" class:active={faceHeld === "B"} aria-label="Circle button (cancel)">
      <svg class="face-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5" /></svg>
    </span>
    <span class="face-btn face-a" class:active={faceHeld === "A"} aria-label="Cross button (confirm)">
      <svg class="face-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="6.5" y1="6.5" x2="17.5" y2="17.5" /><line x1="17.5" y1="6.5" x2="6.5" y2="17.5" /></svg>
    </span>
  </div>
</div>

<style>
  /* Visibility: render only when the device suggests touch + the viewport is
     small enough that controls in the letterbox bars don't overlap the game
     canvas. Desktop with mouse — overlay simply doesn't render. */
  .gamepad-overlay {
    display: none;
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
    /* No animation, no fade — overlay is part of the layout when present. */
    touch-action: none;
  }

  @media (pointer: coarse) and (max-width: 1100px) {
    .gamepad-overlay {
      display: block;
    }
  }

  /* Single touch zones, one per side, anchored to the bottom corners.
     Owner spec: "I'd like them near the bottom instead of centered."
     Bottom positioning matches how a player's thumbs naturally rest
     when holding a phone in landscape. The zone captures any finger
     inside its bounds (pointer-events: auto) and the visible button
     glyphs inside are decorative (pointer-events: none) — touches
     always go to the parent zone, never to a specific button, which is
     what lets a finger move between buttons without lifting. */
  .dpad-zone,
  .face-zone {
    position: absolute;
    bottom: max(12px, calc(env(safe-area-inset-bottom, 0px) + 8px));
    width: 144px;
    height: 144px;
    pointer-events: auto;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
  }

  .dpad-zone {
    left: max(8px, env(safe-area-inset-left, 0px));
  }

  .face-zone {
    right: max(8px, env(safe-area-inset-right, 0px));
  }

  /* === Traditional cross/plus D-pad (single SVG) === */
  .dpad-svg {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 116px;
    height: 116px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    overflow: visible;
  }
  .dpad-body {
    fill: rgba(10, 14, 23, 0.6);
    stroke: rgba(167, 243, 208, 0.65);
    stroke-width: 2.5;
    stroke-linejoin: round;
  }
  .dpad-arm {
    fill: transparent;
    transition: fill 0.08s;
  }
  .dpad-arm.active {
    fill: rgba(167, 243, 208, 0.4);
  }
  .dpad-chevron {
    fill: rgba(224, 231, 255, 0.85);
  }

  /* === Face buttons — circular, PlayStation-style symbol inside ===
     Visuals only, never receive events directly. .active is toggled by the
     touch handler when the finger is currently mapped to that button. */
  .face-btn {
    position: absolute;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: 2px solid rgba(167, 243, 208, 0.65);
    background: rgba(10, 14, 23, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    transition: background 0.08s, transform 0.08s;
  }

  .face-btn.active {
    background: rgba(167, 243, 208, 0.2);
    transform: scale(0.93);
  }

  .face-icon {
    width: 56%;
    height: 56%;
    fill: none;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Face diamond layout: Cross bottom (confirm = most common), Circle right
     (cancel), Square left (select), Triangle top (secondary). Matches the
     PlayStation symbol→position convention. */
  .face-y { top: 0;    left: 44px; }
  .face-a { bottom: 0; left: 44px; }
  .face-x { top: 44px; left: 0;    }
  .face-b { top: 44px; right: 0;   }

  /* Border + symbol stroke per button, in the standard symbol colors. */
  .face-a { border-color: rgba(96, 165, 250, 0.75); }   /* Cross — blue */
  .face-b { border-color: rgba(248, 113, 113, 0.75); }  /* Circle — red */
  .face-x { border-color: rgba(244, 114, 182, 0.75); }  /* Square — pink */
  .face-y { border-color: rgba(52, 211, 153, 0.75); }   /* Triangle — green */

  .face-a .face-icon { stroke: #60a5fa; }
  .face-b .face-icon { stroke: #f87171; }
  .face-x .face-icon { stroke: #f472b6; }
  .face-y .face-icon { stroke: #34d399; }

  /* On very narrow phones (iPhone SE landscape ~ 75pt bars) shrink the
     zone so it doesn't overhang into the game canvas. */
  @media (max-width: 700px) {
    .dpad-zone,
    .face-zone {
      width: 120px;
      height: 120px;
    }
    .dpad-svg {
      width: 96px;
      height: 96px;
    }
    .face-btn {
      width: 46px;
      height: 46px;
    }
    .face-y,
    .face-a {
      left: 37px;
    }
    .face-x,
    .face-b {
      top: 37px;
    }
  }
</style>
