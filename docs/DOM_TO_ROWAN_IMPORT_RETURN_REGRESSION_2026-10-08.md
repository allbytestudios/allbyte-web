# Import return regression from local owner testing

Owner tested the actual local game through the app on 2026-10-08:

- Export worked.
- Import opened the native file browser correctly.
- Returning displayed the themed game confirmation, but its height clipped the
  buttons. Resizing the window corrected the height.
- After resizing, the game cursor remained unresponsive and the normal OS pointer
  remained active, preventing interaction with the confirmation.

This is a failed real-game acceptance case. Previous isolated tests do not close it.
Do not discard the owner's saves or force an import to investigate.

## Source findings (hypotheses, not a reproduced root cause)

`SaveTransferPrompt.gd` calls `_layout()` in `_ready()` and on viewport size change,
but `open_confirmation()` changes wrapped text and shows the modal without a new
layout pass. Its PanelContainer minimum size can also change after container
sorting. Investigate the first rendered frame with realistic long text. Set a
valid wrapping width and bounded message viewport before sizing; resolve layout
after container minimum sizes settle. Ensure the button row remains visible without
an external resize, in landscape and portrait. Merely adding a pre-sort `_layout()`
call may not resolve the changing minimum size.

`WebBridge._native_returned()` only finishes when `_game_has_focus()` sees the
canvas as document.activeElement. `SaveTransferPrompt._input()` consumes every
event while handoff is active, and `resume_native_handoff_from_input()` requires
both the recorded returned flag and that same canvas focus test. Determine which
condition remains false in the exported browser, whether focus is on the iframe
body, and whether legitimate pointer/key input can end handoff. Preserve browser
ownership while the OS chooser is open, but let trusted game interaction recover
after return without requiring a resize or another dialog. Check MenuBase mouse
policy as well: `restore_focus()` intentionally hides the virtual cursor in MOUSE
mode, so distinguish normal mouse policy from a handoff that never finishes.

Capture handoff prompt ID/returned state, canvas activeElement/focus, current input
mode, cursor handoff flag, tree pause/hidden state, panel/minimum size, and button
global rects at selected-file return and first real input. Use the existing isolated
test/browser lane; do not drive the owner's browser profile.

## App state

The app emits correlated opening/returned messages independently of import commit.
Its visible-but-unfocused resume bug has now been fixed locally; all 26 host tests,
five adapter browser tests and TypeScript check pass. A real local export booted
as v0.8.2807 with protocol 2. These results did not exercise a populated-save
confirmation; the owner's test now supplies that missing evidence.

## Acceptance

Add regressions for initial dialog geometry after text/container sorting, plus
native return with iframe body focus followed by real pointer/key interaction.
Then verify against an exported game: Import -> choose populated backup -> every
button visible immediately -> cursor/input responsive -> Cancel preserves saves;
repeat and confirm -> reload -> imported slot loads. Repeat after chooser cancel,
fullscreen exit and viewport change. Keep import acknowledgment gated on successful
storage commit. Export no-modal behavior should remain intact.

This report does not claim a game fix or a verified root cause. Rowan owns the
game changes; coordinate a single local batch export with Arc/Port.
