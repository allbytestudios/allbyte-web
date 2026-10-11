# Dom to Rowan: host tracing implemented

The app half of the correlated save-transfer diagnostics is now implemented in
the development website wrapper. This is observation, not another input-recovery
fix. Owner's normal Windows Chrome import acceptance remains failed/unresolved.

## Read-only interface

The development parent window publishes:

```js
window.__allbyteSaveTrace.schemaVersion // 1
window.__allbyteSaveTrace.read()        // detached JSON snapshot of records
```

The object is frozen and exposes no mutation/action method. Reading does not
change focus, save state or input policy. Internal entries remain in memory across
bridge teardown/reinitialization on the same page, capped at the newest 256.
Sequence numbers increase across that page instance; full reload starts a new
instance ID/history. No persistence, network upload or per-frame logging.
Use the supported session-selecting CON-MCP observation capability to read this
from the intended WEBSITE PARENT, not the executor's unrelated page. The app does
not implement CON-MCP target selection or retarget any existing shared executor.

Production builds do not install this global or run the tracing listeners.

## Record schema / correlation

Common fields: `sequence`, epoch-ms `time`, `event`, `instanceId`, current game
`sessionId`, latest native `promptId`, current pending import `requestId`, `busy`,
native `active`, `recovering`, `inputPresent`, `returned`, `departed`.

`host`: visibility, document focus, classified active element, site build stamp,
iframe pathname (query parameters are excluded).
`game`: document accessibility, visibility, focus, classified active element and
published gameState.version when available. Unknown game version is explicitly
`unknown`; this is not a claim of the desired artifact identity. Site stamp alone
does not fingerprint uncommitted host source; capture source hashes alongside it.

Active-element classifications: none/body/document/canvas/iframe/file_input/
other_control. No text, element values, arbitrary IDs, filenames, file contents,
slot payloads, account data, tokens, debug query strings or keystroke characters.

Events:

- `bridge_initialized`, `bridge_teardown`.
- `import_invoked` includes browser activation state; `chooser_accepted` or
  `chooser_refused` follows. Refusal does not log the raw exception text.
- `native_prompt`: phase/kind/outcome and promptId; exactly the existing protocol
  events. `input_removed` records the independent terminal callback.
- `focus_attempt`: stage returned/settled, restored Boolean and exact guard result:
  no_frame, host_hidden, host_unfocused, host_control, no_canvas, game_control,
  frame_inaccessible, focus_not_acquired or restored. Common snapshots describe
  state after the attempt; preceding native/input-removed entry describes before.
- `file_selected` records byte count only; `backup_validated` records slot count.
- `message_sent`, `message_received`, `request_matched`, `message_rejected` record
  message type and request/session/prompt IDs. `ok` and constrained enum-style
  failure reason are included when present. Source/origin rejections intentionally
  omit untrusted payload IDs. Session/protocol rejection is identified separately.
  Mere receipt is not a claim of game/UI acceptance; `request_matched` means the
  host waiter accepted that type/session/request. Game-side acceptance still needs
  its own trace. No full postMessage payload is copied.
- `import_ack_unresolved` identifies the request whose acknowledgment failed/timed
  out; this does not permit another unresolved write.
- host focus/blur/pageshow/pagehide/visibilitychange/fullscreenchange, game document
  focus/blur, and `visibility_sent` with the actual visible Boolean sent by the
  existing GodotEmbed owner.
- `game_input_capture`: first eight trusted iframe pointerdown/keydown events per
  chooser attempt; only event kind and repeat flag. Capture listener does not
  consume input or claim Godot received it. No key content or pointer coordinates.

## Rowan's remaining half

Expose matching IDs and game gates through read-only observation: native handoff
active/returned, pending import, cursor ownership, hidden/pause/prior-pause state,
confirmation shown/layout generation/readiness, MenuStack top, and first/repeated
input receipt/disposition. Observe transitions and rejecting guards, not every
frame. Include build/source identity and acceptance/rejection of native messages.

Then correlate the NORMAL game Import action through the website wrapper with a
populated backup. The temporary HTML probe is not an acceptance driver. Preserve
overwrite confirmation, cloud-disabled behavior and durable load-complete result.
Cancel/repeated transfer/confirmed import/reload/load remain acceptance gates.

## Verification

27 Node host tests, TypeScript check and eight Chromium adapter checks passed.
The new browser regression asserts correlated prompt/session/request IDs, primary
load-complete matching, omitted payload/filename, detached snapshots and 256-entry
retention. Existing production harness asserts no trace global. Build verification
passed (62 pages); production client bundle scan contains neither the diagnostic
global nor the traced event names. TypeScript was rechecked after wiring sent
visibility. These tests remain adapter/helper evidence, not normal game acceptance.

No game implementation/export, owner browser profile, user saves, deployment or
agent-bus messaging was changed by this work.
