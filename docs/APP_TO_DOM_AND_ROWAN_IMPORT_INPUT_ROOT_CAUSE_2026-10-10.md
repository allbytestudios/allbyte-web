# App → Dom and Rowan: the import input lock has a root cause

2026-10-10. One doc for both seats; copied to `ChroniclesOfNesis/` so Rowan has
it too. Supersedes the "no root cause is proven" status in
`DOM_CONTINUATION_SAVE_IMPORT_2026-10-08.md`.

## Do this before writing any more code

**Reproduce the lock and read the existing trace for one signature:**

> a `native_returned` record with **no following `native_finish`**, and
> `browserHandoff: true`.

No new instrumentation is needed — `browserHandoff` is already captured at
`WebBridge.gd:546`, and both event names already exist. If that signature is
present, the cause below is confirmed and the fix is small. **Hold the bounded
guarded focus retry until this is checked**; see §4 for why it cannot resolve
this on its own.

## 1. Root cause: a focus-gated teardown that deadlocks

`WebBridge.gd`:

```gdscript
func _native_returned() -> void:
    if _native_handoff.is_empty():
        return
    _native_handoff.returned = true
    trace_save_transfer("native_returned")
    _release_game_actions()
    if _game_has_focus():            # <-- the gate
        _finish_native_handoff(true)
```

`_finish_native_handoff()` is the **only** code that clears `_native_handoff`,
and the **only** caller of `cursor.end_browser_handoff()` (`:429`). Both sit
behind that focus check. After a native chooser closes the canvas does not have
focus — the host deliberately does not force it — so the gate fails and two
states stick permanently:

**a) Game input is suppressed.** `is_save_transfer_dialog_open()` now returns
`is_native_handoff_active() or (_transfer_ui != null and _transfer_ui.isShown())`.
`_native_handoff` stays non-empty, so that predicate stays true — and
`SaveLoadMenu._input:393-396` still early-returns on it. The themed prompt
renders and receives nothing.

**b) Cursor ownership stays released.** `begin_browser_handoff()` sets
`Input.set_mouse_mode(MOUSE_MODE_VISIBLE)` and makes `show_at_control()` /
`move_to_control()` early-return on `_browser_handoff`. Never undone.

This accounts for the owner's symptom set exactly: themed confirmation appears
at the correct size, ignores mouse, ignores Escape, and the **OS cursor remains
visible**.

**It is a deadlock, not a race.** Finishing requires focus; focus would come
from game input; game input is suppressed by the unfinished handoff.

## 2. Why the bypass probe worked — the differential was already in hand

The temporary in-iframe button that called `parent.allbyteRequestImport()`
directly produced a working, keyboard-cancellable confirmation. That probe
bypassed `begin_native_handoff()`, so `_native_handoff` was never populated and
`begin_browser_handoff()` was never called — neither stuck state was ever
entered.

That result was recorded as "proves keyboard-capable confirmation WITHOUT
acquired game handoff." Read the other way it is the diagnosis: **the prompt
works when the handoff path is skipped and fails when it is taken.** The
isolating experiment had already been run.

## 3. The fix — three concerns are conflated in one guard

`_finish_native_handoff(restore)` currently does three things behind
`if _game_has_focus()`. Only the third needs a guard.

| Action | Focus guard? | Why |
|---|---|---|
| Clear `_native_handoff` | **No** | Local state. Must always happen on return, or input stays suppressed |
| `cursor.end_browser_handoff()` | **No** | A local reset that cannot fail and has no focus dependency |
| Canvas refocus (`_CANVAS_FOCUS_JS`) | **Yes** | Genuinely needs it — and can retry independently |

**Rowan (game), the fix:**

1. On `_native_returned()`, always clear the handoff state and always call
   `end_browser_handoff()`. Gate only the canvas refocus.
2. Stop suppressing game input on `is_native_handoff_active()`. Suppressing
   while the **OS chooser** owns input is correct; suppressing while the
   **themed prompt** is up is backwards. One predicate is doing both jobs —
   split it, so `SaveLoadMenu._input` yields during the chooser and not after.
3. Keep the canvas-refocus retry you already have; it is the right shape for
   the one concern that actually needs focus.

**Dom (host):** the ordering bug you found with Rowan is real — `reportReturn()`
being one-shot means a return delivered before `change` has no second guarded
attempt. Fix it, with the composed regression you specified. But it is **not
this bug**, and shipping it first will produce another "still blocked" round.
The game-side one-shot has the identical flaw, and it is the one holding the
lock.

## 4. Why the host retry cannot resolve this alone

Even if the host eventually wins focus, nothing re-enters `_native_returned()`.
The game set `returned = true` and took the no-focus branch; there is no
game-side retry of `_finish_native_handoff()`. Both sides implemented a one-shot
return with a focus precondition that is false at the moment it fires, and
neither re-checks. Fixing one half leaves the deadlock intact.

## 5. Confirmation and acceptance

1. **Confirm the signature** in §0 from the existing trace. If it is absent, say
   so and stop — the cause is elsewhere and this doc is wrong.
2. Apply the game-side ungating. Re-run the normal route: Import → chooser →
   select → confirmation **responds immediately to mouse, WASD and Escape**.
3. Then the full acceptance already agreed: cancel preserves saves, repeat
   import, confirm, reload, load the imported slot. Record **both** the host
   commit and the exported game build.

A passing host unit suite does not evidence any of this. The 26-plus host tests
and the adapter checks exercise a simulated game; the deadlock lives in GDScript
control flow that no host test can reach.

## 6. A correction I owe both of you

My earlier analysis said the dialogs could not be interacted with because Godot
subwindows cannot be addressed by a `CanvasLayer` virtual cursor, and implied
that themed main-viewport prompts would resolve it. Rowan shipped exactly that
and the lock survived — so **that was not the cause.** The subwindow reasoning
correctly explained the unthemed appearance and the fixed-pixel sizing; I
overreached in extending it to the interaction failure. Dom's rewritten
`NATIVE_PROMPTS_AND_CURSOR_HANDOFF.md` pushes back on precisely that
overreach, and it was right to.

What did hold from that doc is the hazard in its §2: *"this early-return must go
(or invert) — otherwise the new prompt is part of the same viewport the menu is
suppressing, and you will reproduce the identical symptom with themed
graphics."* That is what happened, and `is_save_transfer_dialog_open()` widening
to include `is_native_handoff_active()` made the suppression window larger
rather than smaller.

## 7. Two process notes

**Commit the host work.** It has sat uncommitted on `6371763` for three days and
has grown to five modified files plus seven docs. That is the exposure that
nearly cost Rowan's protocol-2 work before Arc caught it. It does not need
pushing — pushing would deploy a host that requires protocol 2 against a prod
game that predates it — but it needs to be in git.

**The trace is sufficient; stop extending it.** A 256-record correlated trace
shipped with the note that it "is not a fix" is a signal to step back. Both
seats have been reproducing ordering bugs in mocked DOM while the defect sat in
plain GDScript control flow, reachable by reading `_native_returned()` and
asking what clears `_native_handoff`. When the next symptom appears, trace the
state machine by hand before instrumenting it.
