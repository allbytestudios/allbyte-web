# Local save-transfer check, 2026-10-08

The app server is available at `http://127.0.0.1:4323/play/` for manual testing.
This is a local working-tree test; nothing was published.

Fixed Rowan's visible-but-unfocused resume finding: pageshow, visibilitychange
and focus now require both visible state and document focus before resuming.
The existing focused-iframe exception remains. Added a regression covering an
unfocused visible page receiving all three events and explicit refresh.

Validation completed:

- All 26 host tests passed, including the new focus regression.
- TypeScript check passed.
- All five Chromium simulated-game adapter checks passed, including browser
  download, file chooser and durable import acknowledgment.
- The actual local Godot export booted in a fresh isolated Chromium context,
  negotiated protocol 2 with 12 manual slots, and reported no page errors.
  The title screen displayed game version v0.8.2807.

The fresh browser had no saves, so Continue was disabled. This real-game smoke
check does not establish a populated-save export/import/reload round trip,
overwrite confirmation, OS cancellation or cursor/fullscreen recovery. Those
remain manual/integrated acceptance. The adapter checks use a simulated game.
No existing user browser profile or saves were modified.
