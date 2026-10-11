# Dom to Rowan: terminal focus retry implemented

## Owner retest after this update: FAILED

Owner reloaded and reported focus still did not return; the game additionally
showed `Import failed: empty_import` at the top. Do not mark the owner input lock
resolved based on the passing host tests below.

DAL.validateSaveImport returns empty_import before opening a new confirmation when
there are no writes. Host manual import intentionally sends slots only; therefore
an empty-slot/settings-only backup can trigger it. This is a validation outcome,
not proof that a confirmation button was pressed or a storage write was attempted.
Exact chosen file contents have not been inspected. If an older confirmation is
still visible, capture pending request IDs to distinguish stale UI from this attempt.

The host now rejects empty-slot backups before sending load-saves, using the message
"This backup contains no saved game slots to import. Settings and controls are not
imported." A regression verifies no game request/mutation and successful retry with
a populated backup. This message change does not solve game input recovery.
Need the normal-route correlated game guard trace described in your review.

Host follow-up to `ROWAN_TO_DOM_IMPORT_INPUT_STILL_BLOCKED_REVIEW_2026-10-08.md`
(`gskc0`). The bounded host correction is now implemented locally, uncommitted.

`NativeFilePrompt` has a separate optional settled callback. After terminal
selection/cancel/error or trusted-input fallback removes the input, it invokes
local recovery independently of `reportReturn()`'s one-shot correlated message.
This also runs when early window focus already reported return while the file
input still owned focus. Selection still delivers exactly one file; the protocol
still reports exactly one native return. Destroy/frame replacement suppress the
settled callback, so cleanup cannot reclaim focus.

The save bridge wires this callback for initial setup, iframe load and new game
session setup. It retries the existing guarded `restoreGameFocus()` and emits a
host-only settled event. GodotEmbed uses its existing visibility owner to refresh
on that event, and re-arms gesture-based fullscreen entry. No extra game protocol
message, unconditional focus, timer or global-unpause change was added.

Regression checks compose the actual NativeFilePrompt and restoreGameFocus:
input active -> blur -> early focus -> failed guarded recovery -> terminal input
removal -> successful guarded retry. Selection, cancellation and invocation failure
are covered; one return/one file delivery and no teardown retry are asserted.
Separate terminal checks protect other host/game HTML controls, hidden documents
and unfocused windows.

All 26 host tests, TypeScript checks, seven Chromium browser adapter checks and the
62-page production build pass. The new browser regression uses real DOM/file-input
removal and iframe focus with modeled chooser event ordering; it confirms failed
early focus then successful terminal recovery, one return and one file callback.
Initial browser checks failed to connect because the local server had stopped;
after restarting it on port 4324, all seven passed. These checks do not establish that
the owner's Windows Chrome input lock is resolved. The game receipt path already
marks manual-file delivery as return; your proposed correlated gate trace remains
necessary if normal paired-build acceptance still fails.

No game sources, exports, owner browser profile or saves were modified. Cloud
sync remains disabled. Preserve game overwrite confirmation and durable ack gates.
