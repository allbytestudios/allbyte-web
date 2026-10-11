# Dom → Rowan: native chooser and game cursor return

2026-10-07. The owner asked Dom to implement the app half and Rowan to take the
game half. This file is the handoff; no agent-bus delivery is assumed.

## Division

Dom owns browser chooser lifecycle, host focus/visibility recovery, fullscreen
classification and host tests. Rowan owns themed in-game confirmation/status,
cursor policy, input release and menu focus restoration. Keep game edits in the
game repo and coordinate integration with Arc; no game files are changed by Dom.

Use the existing save-transfer protocol 2 and durable import results. Remove raw
Godot `Window` prompts in favor of existing themed main-viewport `Control` menus.
Keep overwrite confirmation; remove the modal download-start notice. Error/status
feedback must remain visible and usable without introducing another subwindow.

## Browser lifecycle contract being implemented by Dom

The host emits an additive message:

```json
{
  "type": "allbyte:native-file-prompt",
  "protocolVersion": 2,
  "sessionId": "the-running-game-session",
  "promptId": "unique-per-chooser-attempt",
  "kind": "import",
  "phase": "opening",
  "outcome": "pending"
}
```

`phase:"returned"` ends that attempt's native handoff. Outcomes are `selected`,
`cancelled`, `returned` (the page is interactive again but no file result was
reported), or `error`. A returned handoff is NOT an import success or durable
commit result. Keep waiting for the existing correlated `load-complete` for that.
Ignore old prompt/session IDs. Teardown cancels host listeners and retires the
input so delayed callbacks cannot import into a replacement iframe.

Do not wait for `opening` before releasing the cursor: postMessage is asynchronous
and a chooser may block rendering. In the game's Import handler, save the current
menu/focus/navigation policy and prepare for browser handoff **before** calling
`parent.allbyteRequestImport()`. The host function returns true when the chooser
invocation was accepted, false when unavailable/busy/activation refused; restore
immediately on false or exception. The existing wrapper that always returns true
after calling `fn()` must propagate the host's return value.

The host does not force the iframe canvas to focus on return. That would steal
focus from host controls/accessibility tools. Restore game focus only when the
player returns to the game and its current menu still owns the interaction.

## Game work

1. Add balanced begin/end browser-handoff methods to the cursor/menu owner.
   Preserve the focused Control, navigation mode and prior pause state. Hide the
   virtual sprite during the native handoff and make the page pointer usable.
   On return, recompute policy for the current menu; do not blindly force hidden
   cursor or restore a freed/stale Control. Make cleanup idempotent.
2. Release held game actions on focus loss/handoff so a missed keyup does not
   leave movement/accept held. Consume the triggering accept event and prevent it
   from confirming the later import warning or activating the menu underneath.
3. Handle all native return outcomes, host error results, menu close, scene change
   and missing host functions. Preserve an already-paused game when host focus
   returns. The host's visibility message does not mean a new game session.
4. Retain main-viewport themed import confirmation with responsive dimensions,
   keyboard/controller navigation and touch hit targets. Native OS chooser chrome
   is outside the game's rendering; the custom cursor cannot theme it.
5. Test keyboard Import rather than declaring it unsupported: transient activation
   can survive task boundaries until expiry/consumption. Raw Gamepad API polling
   does not grant activation. On refusal, show usable copy requesting a real
   keyboard/mouse/touch action; do not silently do nothing.

Export is a download initiation, not a reliably observable modal lifetime. Do not
hide the cursor or pause indefinitely waiting for a "download closed" signal.
No game success modal is needed for download started.

## Integration evidence required

Use actual game buttons with mouse, keyboard and touch; also verify controller
refusal/fallback feedback. Exercise selected file, cancel, activation refusal,
invalid file, repeated chooser, blur without visibilitychange, background/return,
fullscreen loss, scene/menu change and a slow chooser. Verify cursor, focus and
held-input behavior after every path, then reload and load an imported slot.
Record both the reviewed host commit and exported game build. Host harness tests
do not prove actual Godot cursor restoration or native device picker behavior.

Dom will leave the app completion report in `docs/DOM_TO_APP_NATIVE_PROMPTS_2026-10-07.md`.
