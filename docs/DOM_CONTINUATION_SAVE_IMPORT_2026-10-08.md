# Dom continuation: manual save import input lock

## Host diagnostic tracing now implemented

Development parent exposes frozen `window.__allbyteSaveTrace` with schemaVersion 1
and `read()` returning a detached snapshot of newest 256 records. Correlates native
prompt, session and request IDs, picker/terminal lifecycle, exact focus guard result,
host/game DOM focus states, sent visibility, primary ack matching and first eight
trusted iframe input captures per attempt. No save payloads, filenames, account
data, key contents or debug queries. Listeners are development-only and removed
on bridge teardown; trace history remains in page memory until reload.
See `DOM_TO_ROWAN_SAVE_TRACE_2026-10-08.md`, also copied to GameDev for Rowan.
27 host tests, eight browser adapter checks, TypeScript and 62-page production
build pass. Production bundle scan finds no trace global/event strings. Rowan
still needs matching game guard diagnostics and supported session-selected CON-MCP
observation. This tracing is not a fix for the owner's failed input acceptance.

## Latest update (supersedes unimplemented status below)

The bounded terminal focus retry is now implemented locally. NativeFilePrompt has
a separate settled callback after input removal; all three save-bridge creation
paths wire guarded focus recovery, and GodotEmbed refreshes its existing visibility
owner via a host-only event. One correlated return/one selected file remain intact;
destroy/frame replacement suppress recovery. Added composed early-focus/failed
recovery/terminal-selection tests plus cancel/error/protected-control/hidden/unfocused
and teardown cases. All 26 host tests and TypeScript checks pass. See
Seven Chromium browser adapter checks (including real DOM with modeled early-return
ordering) and the 62-page production build also pass. Local server was restarted
at http://127.0.0.1:4324/ (session 72429) and left running for testing. See
`DOM_TO_ROWAN_FOCUS_ORDERING_UPDATE_2026-10-08.md`. Owner input-lock resolution
is still unverified; this does not replace normal game-route acceptance.

Read this when resuming. Owner requested this continuation note because context /
tokens were nearly exhausted. No fix was implemented in the last review turns.

## Owner goal and latest observed state

Manual save/export/import must work locally. Export works. The normal game Import
button successfully opens Chrome's native file picker. Choosing a backup displays
the themed "Import saved games / Replace saved slots?" confirmation at the correct
size, but OS cursor remains visible and the prompt does not respond to mouse or
Escape. Owner reloaded and retested after the app focus patch; same failure.
Do not confuse our automated action-row activation failure with the owner's route:
the OWNER CAN OPEN THE PICKER. Do not ask for another retry until something relevant
has actually changed and been verified.

User asked who implements: Dom owns the confirmed host ordering fix; Rowan owns
game-side tracing and any demonstrated game fix. Implement Dom's part first,
then paired-build acceptance determines whether another game change is needed.

## Confirmed next app fix (NOT IMPLEMENTED YET)

Read GameDev's `ROWAN_TO_DOM_IMPORT_INPUT_STILL_BLOCKED_REVIEW_2026-10-08.md`
in full. Rowan review bead `ChroniclesOfNesis-3frlt`; host follow-up `gskc0`.

Current NativeFilePrompt can report return on window focus BEFORE file change.
`reportReturn()` is intentionally one-shot. `saves.svelte.ts:handleNativePrompt`
attempts `restoreGameFocus()` only on that return callback. If the temporary host
file input is still active, guarded focus correctly refuses it. Later `finish()`
removes that input, but the second reportReturn call does nothing. The file is
delivered without another guarded focus attempt. Rowan reproduced this composition
with the actual production class/helper and fake DOM/events. This proves a missing
retry under that ordering, NOT causality for the owner's Windows Chrome lock.

Implement a bounded guarded retry AFTER terminal input removal/file selection,
decoupled from the one-time protocol return notification. Keep one correlated
return and one file callback. Cover selection, cancellation and invocation failure
as appropriate. Preserve visible/focused-page requirements, other host/game HTML
controls, unfocused windows and scene/frame lifecycle cleanup. Refresh visibility
through its existing owner when appropriate. No blind timeout release, overwrite
bypass, force commit, unconditional canvas.focus or global unpause.

Add a composed regression: active file input -> blur -> early focus/return ->
guarded focus refusal -> selected file/change -> input removal -> guarded retry
succeeds -> one return/one file delivery. Keep protected-control, hidden/unfocused
negative cases. Existing separate helper tests do not cover this composition.

## What is already implemented locally in allbyte-web

Workspace `C:/Users/drew/Documents/GitHub/allbyte-web`; app HEAD was `6371763`.
Many native-prompt changes remain uncommitted. Recheck git status/log before editing;
App/other agents share the tree. Preserve unrelated changes. Nothing was committed,
pushed or deployed by Dom in these recent tasks. Main push auto-deploys.

- Protocol 2: correlated fresh export; validated import, game overwrite confirmation
  and durable successful acknowledgment before app mirror update. Unknown game-write
  timeout remains protected until matching late result; this is not a cloud lockout.
- `src/lib/native-file-prompt.ts`: one input per chooser, change/cancel/error,
  focus-before-change safe file delivery, one-shot native returned event, trusted
  interaction fallback, fullscreen-recovery flag and cleanup after iframe navigation.
- `installGameVisibility`: balanced blur/focus/pageshow/visibility, resume requires
  visible + document.hasFocus; entering focused iframe does not pause game.
- `restoreGameFocus`: guarded same-origin parent/iframe/canvas focus recovery.
  Called ONLY in handleNativePrompt returned callback currently; this is incomplete.
- `GodotEmbed.svelte`: native fullscreen exit classification and visibility owner;
  custom returned event calls visibility.refresh and re-arms fullscreen gesture.
- Cloud saves DEPRECATED per explicit owner instruction. Removed cloud network,
  revision/conflict handling, merge and debounce from save bridge. Manual imports
  ignore old restore markers; old markers/server data are not deleted. Account
  advertises cloudSaves false; sync entry points are inert. Privacy copy updated.
  Future cloud conflicts must offer explicit user choice, never dead-end import lock.
  See `APP_MANUAL_SAVES_ONLY_2026-10-08.md`.

## Rowan / game state

Game repo `C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis` (outside writable root;
writing requires escalation). ALL handoffs intended for Rowan must be placed there,
per explicit owner instruction. Draft inside app workspace, then approved Copy-Item.
Do not send agent-bus messages unless explicitly authorized.

Rowan committed themed confirmation/native handoff in `7d974a8d`; subsequent fix
`c5175b49` settles initial layout and allows game body/documentElement focus before
reclaiming canvas. Most recent review cites game source `ebe50724`; recheck HEAD.
Actual local exported game seen in diagnostic: v0.8.2809. Standard public index.pck
was updated on Oct 8 at 12:41:54, length 26540332; an export now exists (older notes
that only last night's builds exist are stale).

Relevant GameDev handoffs:

- `ROWAN_TO_DOM_IMPORT_INPUT_STILL_BLOCKED_REVIEW_2026-10-08.md` (latest authority)
- `ROWAN_TO_DOM_IMPORT_RETURN_FIX_2026-10-08.md`
- `DOM_TO_ROWAN_IMPORT_INPUT_STILL_BLOCKED_2026-10-08.md`
- `DOM_TO_ROWAN_IMPORT_RETURN_REGRESSION_2026-10-08.md`

Game `_handle_load_saves()` independently calls `_native_returned()` on a valid
manual import BEFORE confirmation. Thus load-pending should follow an attempt to
mark returned even if native message was missed. WebBridge and prompt both run
PROCESS_MODE_ALWAYS; pause alone does not explain their inability to handle input.
First recovery input is intentionally consumed; check subsequent input separately.
OS cursor alone is not proof of failure because MOUSE mode legitimately uses it.

Need one correlated trace for normal route: action handler, begin handoff result,
host call/activation, opening/returned accepted/rejected, file delivery/load-pending,
first and subsequent input, handoff completion, primary load-complete acknowledgment.
Record session/prompt/request IDs, loaded host/game identities, host/game focus and
activeElement, native active/recovering, game returned/cursor ownership, MenuStack
top, prompt shown/layout-ready/generation, hidden/pause/prior pause, input guard.
If CON-MCP observe lacks this, Rowan should expose read-only diagnostics there;
do not turn injected controls/raw effect hooks into acceptance drivers.

## Evidence and its limits

After cloud retirement: 22 host tests, 5 Chromium adapter checks, TypeScript and
62-page production build passed. After guarded focus patch: 23 host tests,
6 Chromium adapter checks and TypeScript passed. Build not repeated for that patch.
Adapter browser tests use a simulated game, NOT Godot/Windows OS acceptance.

Isolated actual-game seam probe used disposable fixture `boss_even_cure.json` in
localStorage con_nesis_save_1, waited for title/pack readiness, entered Load menu.
Attempts at actual Import action highlighted Import but timed out waiting for a
chooser on Enter/click; this is a separate earlier broken boundary in our harness.
Temporary HTML button inside game iframe called parent.allbyteRequestImport under
real activation, deliberately bypassing game begin_native_handoff; removed before
file selection. Actual picker selected populated slot_1, actual themed confirmation
appeared, canvas focused, game cursor shown/OS mouse hidden. Real Escape cancelled.
Host sequence opening -> returned -> load-saves -> generic cancelled result.
This proves keyboard-capable confirmation WITHOUT acquired game handoff, not normal
game flow or durable successful import. Need primary correlated load-complete and
persistence outcome in acceptance, not just generic cancelled result.

Temporary diagnostic files (ignored .tmp):

- `.tmp/reproduce-import-return.py`: LAST VERSION IS THE BYPASS PROBE, not normal
  acceptance; do not mistake it for a regression test. Prints large gameState.
- `.tmp/real-import-prompt.png`, `.tmp/real-import-cancel.png`, `.tmp/before-picker.png`
- `.tmp/native-prompt-venv/`: Python with Playwright 1.58 + pytest, existing browsers.

Owner browser/profile/saves were never driven or modified by these isolated probes.
Latest probe exec session17869 completed exit0; no test browser should remain.
Local app dev server port4324 was session99775; port4323 also had another listener.
Recheck listeners before starting servers; do not kill others' processes. All recent
browser tests used 4324. Starting duplicate Astro can silently choose another port.

## Commands / permissions

- `node --test tests/save-transfer.test.mjs tests/native-file-prompt.test.mjs`
  requires escalation because sandbox esbuild cannot read parent directories.
- `node node_modules/typescript/bin/tsc --noEmit --pretty false` works sandboxed.
- Browser: set BASE_URL=http://127.0.0.1:4324, RESULTS_DIR=.tmp/native-prompt-browser-results;
  `.tmp/native-prompt-venv/Scripts/python.exe -m pytest tests/e2e/test_save_sync.py -q`
  requires escalation for browser/local network.
- Build: `node node_modules/astro/bin/astro.mjs build`, escalated. Avoid npm build
  here because it invokes unrelated sync-assets. No reason to deploy.
- Game read-only git: command-scoped
  `git -c safe.directory=C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis -C ...`
  avoids ownership error without changing global config. Do not dump full game
  status (thousands of unrelated modified files); scope reads.

## Completion gate

Implement and verify the composed host retry regression first. Update App's docs
and Rowan's GameDev handoff with exact change/test limits. Then test the normal
game Import action through a paired exported build: select file -> immediately
responsive confirmation -> Cancel preserves saves -> repeat/confirm -> reload/load
imported slot. Include repeated identical file, native cancel, focus ordering,
fullscreen/resize and input before async returned message. Owner Windows Chrome
check still required after isolated normal-route acceptance. Be candid: current
import input lock is NOT FIXED and no root cause is proven for the owner's case.
