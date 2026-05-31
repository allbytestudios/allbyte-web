<script lang="ts">
  /**
   * Touch-only virtual gamepad overlay for the /play/ iframe.
   *
   * Sits in the letterbox bars on phones — d-pad in the left bar, 4 face
   * buttons (A/B/X/Y) in the right. The game canvas is unchanged at 1.38:1
   * aspect, so on modern phone screens in landscape the bars are 50-150pt
   * wide, plenty for thumb-sized buttons.
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

  function dispatchKey(type: "keydown" | "keyup", k: { key: string; code: string; keyCode: number }) {
    if (!iframe || !iframe.contentWindow) return;
    const ev = new KeyboardEvent(type, {
      key: k.key,
      code: k.code,
      // keyCode/which are deprecated but Godot's web input handler still
      // checks them on some paths — pass them for compatibility.
      keyCode: k.keyCode,
      bubbles: true,
      cancelable: true,
    });
    // Dispatch at contentWindow so any window-level keyboard listener inside
    // the iframe sees it (Godot's Emscripten input attaches there).
    iframe.contentWindow.dispatchEvent(ev);
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

  function dpadStart(dir: DpadDir, e: TouchEvent | MouseEvent) {
    e.preventDefault();
    press(`d-${dir}`, DPAD_KEYS[dir]);
  }
  function dpadEnd(dir: DpadDir, e: TouchEvent | MouseEvent) {
    e.preventDefault();
    release(`d-${dir}`, DPAD_KEYS[dir]);
  }
  function faceStart(btn: FaceBtn, e: TouchEvent | MouseEvent) {
    e.preventDefault();
    press(`f-${btn}`, FACE_KEYS[btn]);
  }
  function faceEnd(btn: FaceBtn, e: TouchEvent | MouseEvent) {
    e.preventDefault();
    release(`f-${btn}`, FACE_KEYS[btn]);
  }
</script>

<!-- Two clusters — left (d-pad) and right (face buttons). Container is
     pointer-events:none so touches on the game canvas in the middle still
     reach the iframe. -->
<div class="gamepad-overlay" aria-hidden="false">
  <div class="dpad-cluster">
    <button
      class="dpad-btn dpad-up"
      ontouchstart={(e) => dpadStart("up", e)}
      ontouchend={(e) => dpadEnd("up", e)}
      ontouchcancel={(e) => dpadEnd("up", e)}
      onmousedown={(e) => dpadStart("up", e)}
      onmouseup={(e) => dpadEnd("up", e)}
      onmouseleave={(e) => dpadEnd("up", e)}
      aria-label="Move up"
    >▲</button>
    <button
      class="dpad-btn dpad-left"
      ontouchstart={(e) => dpadStart("left", e)}
      ontouchend={(e) => dpadEnd("left", e)}
      ontouchcancel={(e) => dpadEnd("left", e)}
      onmousedown={(e) => dpadStart("left", e)}
      onmouseup={(e) => dpadEnd("left", e)}
      onmouseleave={(e) => dpadEnd("left", e)}
      aria-label="Move left"
    >◀</button>
    <button
      class="dpad-btn dpad-right"
      ontouchstart={(e) => dpadStart("right", e)}
      ontouchend={(e) => dpadEnd("right", e)}
      ontouchcancel={(e) => dpadEnd("right", e)}
      onmousedown={(e) => dpadStart("right", e)}
      onmouseup={(e) => dpadEnd("right", e)}
      onmouseleave={(e) => dpadEnd("right", e)}
      aria-label="Move right"
    >▶</button>
    <button
      class="dpad-btn dpad-down"
      ontouchstart={(e) => dpadStart("down", e)}
      ontouchend={(e) => dpadEnd("down", e)}
      ontouchcancel={(e) => dpadEnd("down", e)}
      onmousedown={(e) => dpadStart("down", e)}
      onmouseup={(e) => dpadEnd("down", e)}
      onmouseleave={(e) => dpadEnd("down", e)}
      aria-label="Move down"
    >▼</button>
  </div>

  <div class="face-cluster">
    <button
      class="face-btn face-y"
      ontouchstart={(e) => faceStart("Y", e)}
      ontouchend={(e) => faceEnd("Y", e)}
      ontouchcancel={(e) => faceEnd("Y", e)}
      onmousedown={(e) => faceStart("Y", e)}
      onmouseup={(e) => faceEnd("Y", e)}
      onmouseleave={(e) => faceEnd("Y", e)}
      aria-label="Y button (secondary)"
    >Y</button>
    <button
      class="face-btn face-x"
      ontouchstart={(e) => faceStart("X", e)}
      ontouchend={(e) => faceEnd("X", e)}
      ontouchcancel={(e) => faceEnd("X", e)}
      onmousedown={(e) => faceStart("X", e)}
      onmouseup={(e) => faceEnd("X", e)}
      onmouseleave={(e) => faceEnd("X", e)}
      aria-label="X button (select)"
    >X</button>
    <button
      class="face-btn face-b"
      ontouchstart={(e) => faceStart("B", e)}
      ontouchend={(e) => faceEnd("B", e)}
      ontouchcancel={(e) => faceEnd("B", e)}
      onmousedown={(e) => faceStart("B", e)}
      onmouseup={(e) => faceEnd("B", e)}
      onmouseleave={(e) => faceEnd("B", e)}
      aria-label="B button (cancel)"
    >B</button>
    <button
      class="face-btn face-a"
      ontouchstart={(e) => faceStart("A", e)}
      ontouchend={(e) => faceEnd("A", e)}
      ontouchcancel={(e) => faceEnd("A", e)}
      onmousedown={(e) => faceStart("A", e)}
      onmouseup={(e) => faceEnd("A", e)}
      onmouseleave={(e) => faceEnd("A", e)}
      aria-label="A button (confirm)"
    >A</button>
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

  .dpad-cluster,
  .face-cluster {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 144px;
    height: 144px;
    pointer-events: none;
  }

  .dpad-cluster {
    left: max(8px, env(safe-area-inset-left, 0px));
  }

  .face-cluster {
    right: max(8px, env(safe-area-inset-right, 0px));
  }

  /* Buttons themselves opt back in to pointer events. */
  .dpad-btn,
  .face-btn {
    position: absolute;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: 2px solid rgba(167, 243, 208, 0.65);
    background: rgba(10, 14, 23, 0.55);
    color: rgba(224, 231, 255, 0.92);
    font-family: "Courier New", monospace;
    font-size: 1.05rem;
    font-weight: bold;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
    transition: background 0.08s, transform 0.08s;
  }

  .dpad-btn:active,
  .face-btn:active {
    background: rgba(167, 243, 208, 0.35);
    transform: scale(0.93);
  }

  /* D-pad layout — cross shape, 144x144 cluster bounds. */
  .dpad-up    { top: 0;    left: 44px; }
  .dpad-down  { bottom: 0; left: 44px; }
  .dpad-left  { top: 44px; left: 0;    }
  .dpad-right { top: 44px; right: 0;   }

  /* Face cluster — diamond layout, A bottom (confirm = most common). */
  .face-y { top: 0;    left: 44px; }
  .face-a { bottom: 0; left: 44px; }
  .face-x { top: 44px; left: 0;    }
  .face-b { top: 44px; right: 0;   }

  .face-a { border-color: rgba(34, 197, 94, 0.7); }
  .face-b { border-color: rgba(239, 68, 68, 0.7); }
  .face-x { border-color: rgba(96, 165, 250, 0.7); }
  .face-y { border-color: rgba(251, 191, 36, 0.7); }

  /* On very narrow phones (iPhone SE landscape ~ 75pt bars) shrink the
     cluster so it doesn't overhang into the game canvas. */
  @media (max-width: 700px) {
    .dpad-cluster,
    .face-cluster {
      width: 120px;
      height: 120px;
    }
    .dpad-btn,
    .face-btn {
      width: 46px;
      height: 46px;
      font-size: 0.95rem;
    }
    .dpad-up,
    .dpad-down,
    .face-y,
    .face-a {
      left: 37px;
    }
    .dpad-left,
    .dpad-right,
    .face-x,
    .face-b {
      top: 37px;
    }
  }
</style>
