# Native browser prompts and game cursor handoff

Updated 2026-10-07 during save import/export implementation. Companion to
[WEB_GAME_BOUNDARY.md](WEB_GAME_BOUNDARY.md).

Use the native file chooser and browser download for portable file transfer.
The host owns browser I/O; the game owns its menus, cursor, input and confirmation.
The browser/OS owns chooser chrome and its pointer. A custom in-game file browser
cannot browse arbitrary filesystem paths without user-granted access; specialized
permission-based filesystem APIs are not a portable replacement for this path.

## Chooser and download are different lifecycles

A chooser takes user input outside the game render surface. A download can start
without opening a modal, and the host cannot observe a universal download-close
or saved-to-disk event. Export must not pause or hide the cursor indefinitely while
waiting for one. Report download started, with no dismiss-modal success notice.

For Import, the game captures its focused Control, navigation mode, cursor policy
and prior pause state before calling the host. It releases virtual cursor/input
ownership and restores the appropriate current policy on return. Do not assume
that hiding a canvas cursor hides the OS-owned chooser pointer; observe that
behavior on supported devices rather than using it as an unverified root cause.

Game confirmations belong in themed, responsive main-viewport Controls. The game's
CanvasLayer cursor cannot simply draw across another Window viewport. This is why
raw Godot subwindow dialogs do not fit this game's cursor system; it is not a claim
that every subwindow is inherently inaccessible by keyboard or touch.

## Host implementation

`src/lib/native-file-prompt.ts` owns one input element and prompt ID per chooser
attempt. `saves.svelte.ts` retains the synchronous same-origin entry point:

```js
parent.allbyteRequestImport() // true: invocation accepted; false: refused
```

A true return does not establish file selection or import success. A false return
or thrown exception lets the game immediately restore the policy it saved before
calling. Activation errors are reported to game UI through save-transfer-result.

The additive game lifecycle message is:

```json
{
  "type": "allbyte:native-file-prompt",
  "protocolVersion": 2,
  "sessionId": "running-game-session",
  "promptId": "unique-per-attempt",
  "kind": "import",
  "phase": "opening",
  "outcome": "pending"
}
```

The closing phase is `returned`; outcomes are selected, cancelled, returned
(page input resumed without a file result), or error. This message restores the
native handoff only. Existing correlated load-complete remains the import result.
PostMessage is asynchronous: the game must prepare its cursor before invoking the
host rather than wait for opening to arrive.

Selection/cancel retires the input. Focus may return before change, so focus return
restores the handoff without throwing the still-pending file away. If a browser
supplies no terminal event, the next trusted nonrepeating keyboard/pointer action
in the host or same-origin iframe retires the abandoned attempt. Old callbacks
cannot deliver a file into a newer chooser or iframe session. No elapsed timeout
is treated as proof that the chooser closed; no second chooser opens merely
because someone spent a long time browsing files.

The cancel event is widely available in modern browsers (across browsers since
May 2023), but recovery should also cover older/embedded environments and failed
invocation. [MDN cancel support](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/cancel_event)

## Focus, visibility and fullscreen

Native dialogs can cause blur without visibilitychange. The host now balances
blur with focus/pageshow and explicit chooser return. Focusing the embedded canvas
while the page still owns focus does not pause the game. Hidden focus cannot resume
it; native return refreshes visibility only when the page is visible and focused.
The game must preserve a pause that already existed before focus loss.

Native fullscreen loss can arrive after chooser change/cancel/focus events. The
host preserves native-exit classification through return until the next trusted
page interaction. It re-arms fullscreen for a later gesture and respects an existing
user opt-out; it does not request fullscreen just because focus returned. It also
avoids requesting fullscreen while the chooser is pending. Actual event ordering
and mobile behavior remain device/browser acceptance checks.

The host does not forcibly focus the game canvas on return. Rowan restores game
focus when the current menu owns the interaction, without stealing focus from host
controls or accessibility tools. Release held game actions so a lost keyup cannot
leave movement or accept held, and consume the initiating accept action so it does
not also confirm an import or activate the menu underneath.

## Activation

Transient activation is timestamp-based and may survive task boundaries until it
expires or an API consumes it. Godot forwarding on a later frame does not alone
prove keyboard Import is impossible. Test navigator.userActivation.isActive at
host entry. Keep the immediate host call to minimize delay.

Trusted keyboard input (excluding Escape/browser-reserved shortcuts), mouse input,
and completed nonmouse pointer/touch gestures can grant activation. Raw Gamepad API
polling does not. An OS/browser controller mapping that produces genuine keyboard
or pointer input is a different path. Synthetic script events cannot manufacture
trusted activation. [HTML activation model](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation)

On refusal, offer a real keyboard, mouse or touch action. Cloud sync is an
alternative transport, not proof of controller-driven filesystem access.

## Acceptance

Exercise selection, cancellation, refusal, repeated chooser, slow chooser, focus
before change, blur without visibilitychange, hidden/visible, fullscreen exit,
menu/scene change and teardown. Check cursor, menu focus, held input and pause state
on each path. Verify actual game keyboard/mouse/touch behavior and controller
feedback. Then verify the imported slot survives reload and actually loads.

Host unit/adapter tests do not prove OS dialog pointer behavior, actual Godot cursor
restoration, or iOS/mobile fullscreen ordering. Record both the reviewed host commit
and exported game build for integrated results.
