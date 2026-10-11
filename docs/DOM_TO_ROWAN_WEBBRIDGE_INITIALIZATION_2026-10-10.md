# Dom to Rowan: diagnose and repair missing WebBridge registration

The owner confirmed that both game-iframe globals are undefined after reloading the normal Windows Chrome wrapper:

```text
typeof window.__nesisWebBridgeCB       === 'undefined'
typeof window.__nesisWebBridgeListener === 'undefined'
```

Test URL: `http://127.0.0.1:4325/play/?copilot=902009`. The loaded game reports public version `0.8.2813`. Owner boot logs show copilot opt-in, TestBridge readiness, successful Laria pack loading, and continued music activity. They include a parent-node `remove_child()` error at `scene/main/node.cpp:1738`, without a GDScript caller stack; its connection to the bridge failure is unproved.

## Requested game-side work

Determine why the loaded export lacks both WebBridge globals. Inspect the actual exported initialization path and distinguish `_ready()` not running, early exit/error, failure during listener installation, and later loss of registration/context. Capture the first initialization failure with its stack and timing. Do not assume stale cache or prescribe an unchanged export as the fix.

Repair the demonstrated initialization/registration failure. Ensure public-build save reception works without a debug token or external Autoplay. Make advertised save readiness/capabilities reflect an operational receive path, or expose an explicit unavailable state, while preserving unrelated gameplay startup.

Expose bounded startup, registration, publisher attempt/status/error observations through the supported diagnostic seam (`ChroniclesOfNesis-pgfzo`). Keep local numeric copilot opt-in diagnostic-only. The earlier node-property probe used a public build without debug authorization and timed out; it establishes no game property values.

Coordinate one local export through the established batch workflow after the fix and relevant verification. Return source commit, game version, export location, asset manifest/hashes, runtime registration evidence, and a correlated host-to-game request/response check. Dom will verify/copy the exact coordinated export into the wrapper asset directory and check served identities. No hosted promotion is requested.

## Prior import evidence and limits

The earlier failed import's host trace shows successful canvas focus restoration, file selection, validation of one saved slot, attempted `allbyte:load-saves` dispatch, and real DOM pointer/key events while the canvas was focused. The acknowledgment timed out after 120,003 ms. Game receipt, native-handoff guard state, and durable import outcome remain unknown. The callback check was after reload and does not retrospectively establish callback state during that earlier request.

Source/raw trace and detailed evidence: `allbyte-web/docs/LOCAL_IMPORT_TRACE_FINDINGS_2026-10-09.md` and `C:\Users\drew\Desktop\GameDev\Bugs\JSONFrameTraceDump.txt`. Rowan's review: `ChroniclesOfNesis/ROWAN_TO_DOM_LOCAL_IMPORT_TRACE_FINDINGS_REVIEW_2026-10-09.md`.

The local app's exact `POST /event` route now forwards to the existing collector on port 8060 and returns 204; real transition events arrive. That separate channel is repaired. Dedicated session trace publication is still absent. Callable globals alone are insufficient: verify the listener is attached and reaches Godot with a correlated response.

## Gate before the next owner import

Require working registration and a correlated receive/response check on the actual wrapper, then a fresh paired diagnostic record with matching host origin/path, iframe boot/game session, runtime identities, and complete host/game evidence. Pin that session before interpreting observations.

After this baseline passes, exercise the normal menu flow: chooser cancellation restores input; selecting a populated backup yields responsive confirmation; Cancel preserves saves. Then a deliberate confirmed import must produce durable acknowledgment, preserve its result after reload, and load the resulting slot. Verify input recovery separately from persistence. Keep `7ix7o`, `pgfzo`, and `gskc0` open until their respective checks pass.

Do not clear browser storage, automatically retry an unknown import, discard unresolved-request protection, force focus/global unpause, bypass confirmation, or drive the owner's browser to collect evidence. Preserve Quinn's executor and unrelated services. No further owner import retry is requested before readiness evidence exists.

This document is a local handoff artifact; it has not been sent through the agent bus.
