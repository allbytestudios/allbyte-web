# Import input still blocked after canvas-focus changes

Owner retested in Chrome after reloading the app: selecting the backup displays
the correctly sized themed "Import saved games / Replace saved slots?" prompt,
but the normal OS pointer remains visible, mouse cannot interact, and Escape does
nothing. Treat this as failed real exported-game acceptance. Do not request another
owner retry based only on isolated focus-helper tests.

The app now retires cloud sync entirely (account cloudSaves false, manual imports
never consult cloud state). It also tries guarded same-origin canvas focus on
picker return, preserving other host/game HTML controls and unfocused windows.
That patch did not resolve the owner's normal game-menu route.

## New boundary evidence

An isolated Chromium run used a disposable local save fixture and actual local
export v0.8.2809 through the app at port 4324. After entering the title's Load Game
menu with real input, a temporary HTML probe button inside the game iframe called
the existing parent.allbyteRequestImport() under real browser activation. The
probe button was removed before selecting the backup. This deliberately bypasses
WebBridge.begin_native_handoff(), so it is a seam diagnostic, NOT normal game-menu
acceptance.

The browser file chooser selected a populated slot_1 backup. The actual Godot
confirmation appeared; canvas had focus, virtualCursorShown and mouseModeHidden
were true. A real Escape key cancelled the import; the host recorded
allbyte:save-transfer-result with status cancelled. Existing fixture data remained
local. The recorded host sequence was native opening, native returned, load-saves,
then cancelled result after Escape.

This shows that the exported confirmation can receive keyboard input when the
game-native-handoff state is not acquired. Compare that route with the owner's
normal SaveLoadMenu -> begin_native_handoff -> chooser -> confirmation route.
It supports investigating native handoff completion/ownership, but does not prove
which guard is stuck or rule out OS-specific focus/visibility event ordering.

Attempts to activate the real Import action in this isolated title-menu run
highlighted Import via ArrowUp/ArrowRight but timed out waiting for a chooser
after Enter or click. Do not count these attempts as successful reproduction of
the owner's full route. The temporary probe was introduced to isolate the seam.

## Required next evidence

Instrument actual exported-game state at native opening, return, load-pending and
first pointer/key event: promptId, returned flag, retired prompts, pending import,
_game_has_focus result, iframe activeElement/document.hasFocus, _hidden/tree pause,
current MenuStack top, transfer layout-ready flag and cursor browser-handoff flag.
Confirm that the correlated returned message reaches the game and that successful
handoff completion runs exactly once. Exercise actual OS-picker return in Chrome;
Playwright set_files does not model every Windows native-dialog focus event.

Do not fix this by bypassing overwrite confirmation, forcing import commit, globally
unpausing the game or indiscriminately stealing focus. The acceptance gate is the
normal game action -> chooser -> immediately responsive confirmation -> Cancel
preserves saves, then confirmed import -> reload -> slot loads.

Game fixes remain Rowan's scope; coordinate a single updated local export with
Arc/Port. No additional speculative app patch was made after this failed owner
retest. The diagnostic used a fresh browser context, not the owner's saves/profile.
