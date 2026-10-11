# Wrapper iframe focus recovery after bridge repair

Owner reports that the repaired game loads but neither mouse nor keyboard moves the cursor, before import testing. Live collector record for copilot `902009`, session `1791680451.245-930912890`, timestamp `1791680491516` shows the actual first blocking condition:

- WebBridge registered; publisher HTTP 204, no publication error.
- Host and game documents visible and focused; host active element iframe, game active element canvas; `gameFocusAllowed:true`.
- Game `hidden:true`, `paused:true`, `pausedBeforeHide:false`.
- `nativeActive:false`, `browserHandoff:false`, no pending import or confirmation.
- Host sequence 29 sent `visibility_sent:false` after focus left; subsequent sequences 32–35 and 40–43 show game focus returning without a matching visibility-true notification in that slice.

The host visibility adapter listened to the parent Window's focus, but focus can return directly to the iframe without a parent focus event. The newly functioning WebBridge now processes the pause message, exposing this host omission. This is a separate failure from missing game receiver registration or chooser handoff.

## Local host repair

`installGameVisibility()` can now watch the frame Window's focus and trusted pointer/key events. A visible, focused host document can send the matching resume notification; hidden or unfocused pages cannot. Repeating/synthetic input does not trigger interaction recovery. The wrapper attaches the watchers to the current iframe and reattaches on load, removing old listeners during replacement and teardown.

No game focus guard, confirmation, storage protection, or native handoff guard was changed. The game continues to decide whether a visibility resume may restore pause based on its existing ownership state. No direct tree-unpause setter was used.

## Validation

All 29 save-transfer/native-prompt tests passed, including two new regressions for direct iframe focus recovery and the hidden/unfocused/trusted-input/listener-cleanup constraints.

A disposable profile loaded the actual wrapper and repaired public export with reserved ID `99101013`. Headless tab switching did not lose focus, so the successful regression explicitly staged only the host document's unfocused state and dispatched its blur notification, then restored the browser focus query and clicked the actual canvas with real pointer input. The actual game changed from `hidden:true, paused:true` to `hidden:false, paused:false` through ordinary host visibility messages. Its game session remained `1791730034.913-2226430571`, and the resumed game document was focused. This checks a real runtime against a staged host lifecycle condition, not Windows native focus acceptance.

Evidence: `.tmp/frame-focus-recovery-evidence.json`; script: `.tmp/verify-frame-focus-recovery.py`. Owner Windows controls recovery remains pending. Reload the normal wrapper, verify cursor/keyboard operation first, and only then resume chooser-cancellation testing. No owner profile/storage, import, game source, export, or hosted deployment was modified by this repair. Host changes remain local and uncommitted.
