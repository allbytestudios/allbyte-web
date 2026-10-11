# Dom to Rowan: activate save-transfer tracing for the local test

Drew requests that we finish preparing the paired local diagnostic test. Your tracing implementation is confirmed in commit `9c45473a`; your latest handoff states that runtime activation and a fresh wrapper-served export are still outstanding. The import input lock remains unresolved. Please pick up the game/provider activation work below and return a readiness handoff.

## Requested Rowan work

1. Confirm the game tracing commit and provider observer changes are integrated into the versions being activated. Build and activate the provider through the established workflow, exposing `autoplay_save_transfer_trace` without retargeting or restarting Quinn's browser executor.
2. Coordinate a local maintenance window and restart the snapshot collector using the updated script. Verify the new `/save_transfer_state.json?id=N` POST/GET route works and retains the existing legacy snapshot behavior. Report any coordination blocker rather than disrupting an active shared session.
3. Coordinate one game export through the established batch/export workflow. Produce the build containing the tracing changes and identify the resulting game version and source commit. Coordinate with Dom to copy/serve that exact export through the app wrapper's actual asset directory; updating the direct `:8060` export alone is insufficient.
4. Once Dom's forwarding change and the paired export are available, verify an opted-in local wrapper publishes a fresh schema-1 record and that `autoplay_save_transfer_trace` can read it with the expected host origin/path. Use a unique numeric copilot ID and pin the returned game session for subsequent observations. If the wrapper is not available yet, report that dependency explicitly.

## Dom-owned work

I will review/apply your `tools/save_transfer/host_copilot_forwarding.patch` to `GodotEmbed.gameSrc()`, preserving the local DEV-only numeric opt-in. The host trace API is already implemented. I will verify hydration forwards the query to the iframe, coordinate the app-side asset copy/serving, and confirm the host build used in the paired test. You do not need to edit the shared dirty host files.

## Readiness evidence to return

- Game and provider source commits, exported game version, and export location.
- Collector/provider activation status and the actual endpoints used.
- Actual wrapper URL and loaded game version; host build identity or an explicit statement that it is still unavailable.
- A fresh observer read with the chosen copilot ID and game session; whether host trace fields are present and whether retention/truncation affects the evidence.
- Any remaining dependency or blocker before Drew can test in Chrome.

Keep build/activation readiness separate from owner acceptance. A successful observer read does not mean import succeeded or input recovered.

## Owner test after readiness

Drew should use the normal game menu in the app wrapper with populated saved slots and a valid backup. First observe chooser cancellation and input recovery without changing saves. Then observe file selection, the first recovery input, and a fresh Escape/Cancel. Capture host focus attempts and DOM input alongside game native-handoff state, prompt guards, and actual input disposition. Stop at the first rejecting guard; do not force focus, unpause, or bypass confirmation.

Only after cancellation/input recovery works should a deliberate confirmed import be checked for durable acknowledgment, persistence after reload, and loading the imported slot. Keep the input-lock issue open until this normal Windows Chrome flow passes. Do not commit or deploy host changes as part of this request.

Reference: `ROWAN_TO_DOM_SAVE_TRANSFER_TRACING_2026-10-09.md` and `DOM_TO_ROWAN_SAVE_TRACE_2026-10-08.md` in GameDev.
