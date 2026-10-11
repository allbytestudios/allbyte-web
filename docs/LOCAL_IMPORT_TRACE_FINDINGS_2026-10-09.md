# Local import failure: host trace and missing game bridge callback

Owner retested the normal import action through `http://127.0.0.1:4325/play/?copilot=902009` and reported no control after selecting the backup. Input recovery and import acceptance remain unresolved.

Evidence supplied by owner: `C:\Users\drew\Desktop\GameDev\Bugs\JSONFrameTraceDump.txt`. The dump contains host trace sequences 37–76, not the complete opening sequence.

## Observed host sequence

- Iframe URL includes `copilot=902009`, with `/godot/public/index.html` and game version `0.8.2813`.
- Game session: `1791568944.272-3252664942`; prompt: `18ab0de5-97a7-4c78-ae1a-02caf1690ebb`; import request: `798193f8-5c6c-4a0f-865d-48e46f9cd270`.
- Sequence 48: return-stage focus recovery succeeds; game document is visible, focused, and its active element is canvas.
- Sequence 49: host sends `allbyte:native-file-prompt` with matching session/prompt identifiers. The trace records the message type but not its phase; its location in the host return handler indicates the return notification.
- Sequences 50–51: file input is removed and settled-stage focus recovery succeeds.
- Sequence 52: an 18,693-byte file is selected.
- Sequence 53: backup validates with one saved slot.
- Sequence 54: host sends `allbyte:load-saves` with the correlated import request.
- Sequences 55–62: browser DOM captures real pointerdown and keydown events while canvas is focused. These prove DOM delivery, not Godot acceptance. Repeated capture records are present, so do not count each record as a separate physical action.
- Sequence 75: import acknowledgment times out approximately 120 seconds after the request. No game response appears in this trace slice.

This establishes host-side chooser completion, successful focus recovery, backup validation, and request dispatch. It does not prove the game received those messages or identify a stuck Godot input guard. Later unfocused records follow the real input attempts and cannot explain the earlier failure by themselves.

## Runtime and reporting checks

All 15 served wrapper assets match `ROWAN_LOCAL_TRACE_EXPORT_MANIFEST_2026-10-09.json` (tracing export `0.8.2813`). The collector recognizes the trace POST route: an empty-body probe returns 413 without writing session data. The session's trace file, state snapshot, and console file are absent.

The app now forwards the exact local `POST /event` route to the existing collector at `127.0.0.1:8060`, before Astro's trailing-slash guard. A labeled probe returns 204, and actual game scene/dialogue events arrive afterward. This fixes transition-event delivery but does not fix the import lock.

A separate disposable Chromium session at copilot ID `904009` boots the same served public build. It reports `typeof window.__nesisWebBridgeCB === 'undefined'` and emits no save-transfer POSTs. Its captured console reports a parent-node remove-child error during boot, with no established causal link to WebBridge. A subsequent read-only node-property probe times out; no node-property values were obtained.

Source `WebBridge._ready()` is supposed to install both `__nesisWebBridgeListener` and `__nesisWebBridgeCB` and enable opted-in diagnostic publishing. Their initialization is the next boundary to inspect, including the compiled exported script versus source and initialization lifetime. The isolated callback finding must be confirmed in the owner's tab before treating it as the owner's exact root cause.

No owner saves, browser state, game source, exports, commits, or hosted deployment were changed by this investigation. A read-only owner-console check for callback/listener presence and recent engine logs is pending. Preserve overwrite confirmation and durable acknowledgment; do not globally unpause or bypass input guards.

## Owner callback check confirmed after reload

The owner subsequently supplied the read-only callback/listener check from the reloaded page. Both `typeof window.__nesisWebBridgeCB` and `typeof window.__nesisWebBridgeListener` are `undefined` in the game iframe. This confirms the missing-registration symptom in the owner's actual session, independently of the disposable browser.

The supplied boot logs identify the public build, copilot ID `902009`, TestBridge boot timestamp `1791569470166`, and pack URL `/godot/public/packs/Laria.pck?v=0.8.2813`. They show `allbyte:ready` emitted, subsequent successful Laria download and mount, and continuing startup/music activity. Readiness advertising therefore coexists with absent WebBridge callback/listener globals.

The logs also contain the parent-node `remove_child()` error at `scene/main/node.cpp:1738`, but do not supply a GDScript stack identifying its caller. Its causal connection to missing registration remains unproved. No explicit WebBridge initialization error appears in the supplied log tail.

This new evidence supersedes the pending owner-global-check status above. The first actionable boundary is WebBridge initialization/registration in the loaded export: determine whether `_ready()` runs, exits or fails before registration, or registration is subsequently removed. Source shows registration belongs in `_ready()`; absence alone does not distinguish those causes or prove a stale cached script. The new check was after reload, so do not equate it with a direct observation of the prior failed import session.

Do not request another owner import until the real page has callable callback/listener globals and fresh paired diagnostic publication. No game-runtime fix or accepted import is claimed.
