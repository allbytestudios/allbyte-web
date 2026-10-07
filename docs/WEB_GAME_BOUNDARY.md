# Web ↔ Game Boundary

**Status:** Save protocol 2 host implementation; coordinated game/browser acceptance required.
**Last updated:** 2026-10-07.

This is the canonical reference for what lives on the web side
(`allbyte-web`) versus the game side (Chronicles of Nesis, Godot 4 web
export) and how the two communicate. It exists because the responsibilities
got non-obvious as we moved more chrome into the game, and getting the line
wrong here is what caused the 2026-05-31 black-screen bug (different cause,
similar character).

## Overview

The Chronicles of Nesis web playable is a Godot HTML5 export embedded in an
iframe on `allbyte.studio/play/`. The web side renders the iframe; the game
side renders everything *inside* it. Both run on the same origin
(`allbyte.studio`), which is what makes the cross-frame protocol below
practical — same-origin iframes can use direct `parent.fn()` calls *and*
postMessage; we use both where appropriate.

## The line: who owns what

| Function | Owner | Why |
|---|---|---|
| Iframe lifecycle (mount, unmount, fullscreen) | **Web** | The play container is a Svelte component on the page. |
| Auth state, user tier, JWT | **Web** | Lives in localStorage + reactive Svelte store. Game receives derived state. |
| Save data caching | **Web** | An acknowledged mirror in `saves.svelte.ts`, cleared on teardown; stale account responses are discarded. Cloud sync is available to all signed-in accounts. |
| Server sync (push/pull saves to DynamoDB) | **Web** | Hits the backend Lambda directly. Game gets sync status as a derived signal. |
| Browser file picker for save import | **Web** | Mobile browsers gate file-picker access on user-gesture context; the only way to preserve it across the boundary is a direct same-origin call. See ["Direct calls vs postMessage"](#direct-calls-vs-postmessage) below. |
| Browser file download for save export | **Web** | Same gesture-context constraint. |
| Closing the play iframe ("back to home") | **Web** action, **game** trigger | Game's own "Quit" button posts the request; web tears down the iframe. |
| Touch-to-keyboard translation (virtual gamepad) | **Web** | Game has no touch input layer. Web overlays an HTML d-pad + face buttons and translates touches into synthetic `KeyboardEvent`s. |
| Top header (Back / Save / Load / Sync) | **Game** | Web's `PlayOverlay` was removed 2026-05-31. ESC key still exits play mode on desktop as a fallback. All other actions are game-side. |
| Save/load slot management | **Game** | The game owns its save schema and slot semantics. Web only sees opaque per-slot blobs. |
| Confirmation dialogs ("are you sure?") | **Game** | Per owner spec — web never prompts; game asks first if needed. |
| Camera pan / zoom on touch | **Web** (deferred) | Two-finger pan + pinch zoom will live in the same touch layer as the gamepad. Not in v1. |

## Cross-frame protocol

There are two communication channels and they serve different purposes:

### postMessage (asynchronous, event-shaped)

Used for state events and one-shot requests that don't need user-gesture
context. Messages have the shape `{ type: "allbyte:<verb>", ...payload }`.

#### Game → Web

| Type | Payload | Web action |
|---|---|---|
| `allbyte:ready` | `protocolVersion: 2, sessionId, maxSaveSlots, saveCapabilities` | Negotiate capabilities, broadcast account/status, request fresh saves before cloud merge. Older builds cannot use reliable transfer. |
| `allbyte:save-changed` | `protocolVersion: 2, sessionId, slotId: number, data: string` | Updates web's cache; schedules a debounced push to the server. |
| `allbyte:all-saves` | `protocolVersion: 2, sessionId, requestId, saves, options, keymapping` | Resolves only the matching snapshot request. Unrequested snapshots are ignored. |
| `allbyte:load-complete` | `protocolVersion: 2, sessionId, requestId, ok, reason, status, acceptedSlots, rejectedSlots, snapshot` | Successful durable acknowledgment replaces the mirror; failed/cancelled operations preserve it. |
| `allbyte:load-pending` | `protocolVersion: 2, sessionId, requestId, status` | Game is awaiting confirmation; no host mutation or upload. |
| `allbyte:request-exit` | — | Fallback path for the same direct call below. Web closes the iframe. |
| `allbyte:request-export-saves` | — | Fallback. Will silently fail the browser download on iOS Safari — use direct call. |
| `allbyte:request-import-saves` | — | Fallback. Will silently fail the file picker on most browsers — use direct call. |

#### Web → Game

| Type | Payload | Game responsibility |
|---|---|---|
| `allbyte:request-saves` | — | Reply with `allbyte:all-saves`. |
| `allbyte:load-saves` | `protocolVersion: 2, sessionId, requestId, source, saves, cloudSlots` | Validate complete candidate, confirm imports, commit durably, refresh UI, reply with `allbyte:load-complete`. Settings omitted until game opt-in exists. |
| `allbyte:save-transfer-result` | `status, message` | Game displays host picker/read/download failures and download-start feedback. |
| `allbyte:sync-status` | `status: "idle"\|"syncing"\|"synced"\|"error"\|"unsynced"`, `lastSyncedAt: number\|null`, `errorMessage: string\|null` | Update any in-game sync indicator. Broadcast on every state change and once on `ready`. |
| `allbyte:visibility` | `visible: boolean` | Page visibility (phone screen on/off, tab background/foreground). Game should pause audio + sims when `visible: false` and resume when `visible: true`. Broadcast on every `document.visibilitychange`. |
| `allbyte:update-available` | — | A new build of the site has been detected (new service worker activated). Game should record this flag and apply the update at a safe moment — typically when the user is on the Title screen — by calling `parent.allbyteApplyUpdate()`. Web will NOT auto-reload by itself, so the game decides when. |
| `allbyte:download-progress` | `bytesDownloaded: number`, `expectedBytes: number`, `filesDownloaded: number`, `currentFile: string \| null` | Transport-level download stats observed via `PerformanceObserver` on the iframe's `/godot/*` resource entries. Game owns the visible loading UI (Chronicles boot shell + in-game LoadingScreen); web reports what's happening on the wire so game can drive a real progress bar instead of a time-based animation. Posted on change only (no events when bytes are static). On warm SW-cache hits, this never fires because no network bytes accumulate — game should fall back to its own indicators in that case. |

### Direct same-origin calls (synchronous, user-gesture preserving)

Used **only** for actions that require user-gesture context — the browser
won't open a file picker or trigger a download otherwise. Because the
iframe is same-origin with the parent, `JavaScriptBridge.eval()` from
GDScript can call into the parent window directly. This preserves activation
only if the browser still considers the gesture active; verify actual Godot
mouse, touch, keyboard and controller paths. Same-origin alone is insufficient.

GDScript pattern:

```gdscript
# From a button _pressed() handler — synchronously, so user activation
# from the touch event is still live when the parent JS runs:
JavaScriptBridge.eval("parent.allbyteRequestImport()")
```

| Function | Web behavior |
|---|---|
| `parent.allbyteRequestExit()` | Tears down the play iframe; user returns to landing page. |
| `parent.allbyteRequestExport()` | Asks the game for fresh save state via `allbyte:request-saves`, requires a matching fresh reply within five seconds, then triggers a browser download of `chronicles-of-nesis-saves-<ts>.json`. |
| `parent.allbyteRequestImport()` | Opens a hidden `<input type="file">` browser dialog. On file pick, web validates the versioned envelope and size, then sends saves only with a correlated `allbyte:load-saves`. Game validates, confirms and commits before host/cloud updates. |
| `parent.allbyteApplyUpdate()` | Brief "Updating..." overlay, then `location.reload()`. Game should call this when an update is pending AND it's a safe moment (Title screen). |
| `parent.allbyteUpdatePending` | Boolean property the game can poll on Title screen ready. True if a new build has been detected since this page loaded. |

These three functions exist on `window` for the lifetime of `initSaveBridge`
(i.e., while play mode is active) and are removed in `teardownSaveBridge`.

### Direct calls vs postMessage

Use `parent.allbyteRequest*()` for gesture-dependent actions. Use
postMessage for everything else. Both forms exist for `exit`,
`export-saves`, and `import-saves`, but the direct call is the only one
that can preserve user activation; actual iOS behavior remains an acceptance gate.

The postMessage fallback exists for symmetry — if Arc/Port wires it that
way, exit/export will still work on permissive browsers, but import will
silently fail to open the picker.

## Validation expectations

- **Web** does a *basic shape check* on imported files: must parse as JSON,
  must have version 1 and an object of canonical manual-slot keys with opaque string payloads. Bound file/bundle size to 8 MiB; reject explicit wrong-game identifiers and unsupported versions. No nested slot-schema validation. Unknown envelope metadata is not restored; slot strings remain intact.
- **Game** does full schema validation. If a slot fails validation, surface
  via `allbyte:load-complete`'s `rejectedSlots` so the web cache stays
  consistent.
- **Host lifecycle** rejects wrong source/origin/session, clears pending requests on teardown, and never exports a cached fallback. Import timeout means result unknown; block subsequent transfers/uploads until a late result is reconciled.
- **Cloud** uses conditional revisions, serialized requests and account/session/mutation checks. Pending restore intent survives reload; cloud failures preserve local saves. Conflict resolution must be explicit, never an automatic timestamp merge over a restore.

This split is owner spec: "Basic shape should be confirmed, but not full
schema validation."

## Virtual gamepad

Touch-only overlay rendered by `src/components/VirtualGamepad.svelte`.
Visible when `@media (pointer: coarse) and (max-width: 1100px)` matches —
i.e., touch devices on phone/small-tablet form factors. Desktop never
renders it.

Layout: d-pad (4 directional buttons) in the left letterbox bar, 4 face
buttons (A/B/X/Y) in the right. The game canvas keeps its full visual
area because the controls live in the letterbox bars created by the
game's 1270×920 (≈1.38:1) aspect ratio.

Input mapping (derived from `project.godot [input]`):

| Virtual button | Synthetic key | Game action(s) |
|---|---|---|
| D-pad ↑ | `ArrowUp` | `ui_up` / `move_up` |
| D-pad ↓ | `ArrowDown` | `ui_down` / `move_down` |
| D-pad ← | `ArrowLeft` | `ui_left` / `move_left` |
| D-pad → | `ArrowRight` | `ui_right` / `move_right` |
| A | `Enter` | `ui_accept` |
| B | `Escape` | `ui_cancel` |
| X | `Space` | `ui_select` |
| Y | `KeyE` | `ui_secondary` |

Dispatch goes to `iframe.contentWindow.dispatchEvent(new KeyboardEvent(...))`.
If `event.isTrusted: false` ends up blocking input in Godot's web runtime,
fallback is for Port to add a small postMessage handler that translates
`{type: "allbyte:input", action: "ui_left", pressed: true}` into a real
`InputEventAction`. ~10 lines of GDScript. We'll only do this if synthetic
events don't work.

## Phasing

1. **Phase 1 (web — done 2026-05-31):**
   - Extended postMessage protocol with sync-status broadcast and
     game-initiated request types.
   - `window.allbyteRequest*` direct call surface for gesture-dependent
     actions.
   - `VirtualGamepad.svelte` overlay.

2. **Phase 3 (web — done 2026-05-31):**
   - `PlayOverlay.svelte` deleted. The 52px header is gone on both
     desktop and mobile. The game iframe gets the full play container.
   - Owner spec: "Back is synonymous with Quit in-game now." Until
     Arc's in-game quit ships, desktop users use ESC and mobile users
     close the tab / PWA window.
   - Done out of order with Phase 2 (game side) because the owner prioritized
     clean UI now; Arc will add the in-game equivalents in Phase 2.

3. **Phase 2 (game — Arc/Port, pending):**
   - Add Import / Download buttons to in-game load screen.
   - Add Quit / Back option in title or pause menu. Wire to
     `parent.allbyteRequestExit()`.
   - Render a sync-status indicator wherever fits the game's visual
     language; subscribe to `allbyte:sync-status`.

## Future expansion

- **Two-finger pan / pinch zoom for camera** — owner intent is to map
  pinch → `cam_zoom_in`/`cam_zoom_out` mouse-wheel buttons, two-finger
  drag → `cam_drag` middle-mouse button. Will live in the same touch
  layer as the virtual gamepad. Deferred until game-side touch design
  lands.
- **Orientation hint** — prompt user to rotate to landscape when they
  land on `/play/` in portrait on mobile.
- **PWA manifest** — installable to home screen for the "show your
  friends on their phone" use case.

## References

- `src/lib/saves.svelte.ts` — the bridge implementation.
- `src/components/VirtualGamepad.svelte` — touch overlay.
- `src/components/BilateralLayout.svelte` — mounts the iframe + gamepad.
- `project.godot [input]` — canonical InputMap; the gamepad's key mapping
  is derived from this and will need to stay in sync if the input map
  changes.
