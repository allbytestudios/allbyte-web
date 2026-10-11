# Dom to App: native prompt implementation

2026-10-07. App-side work is implemented locally on top of save-transfer commit
`6371763`. Nothing was committed, pushed or deployed by this task. Rowan's handoff
was also copied into the game repository's root as
`DOM_TO_ROWAN_NATIVE_PROMPTS_2026-10-07.md`, where Rowan can access it.

## Implemented

`src/lib/native-file-prompt.ts` owns one input per chooser attempt, resets identical
file selections, handles change/cancel and invocation failures, and retires stale
callbacks on teardown or frame replacement. Focus may return before change: it
reports browser return without discarding a potentially selected file. When a
browser provides no terminal chooser event, the next trusted page/iframe interaction
retires the pending input. Synthetic events and repeating keys cannot unlock it.
Cleanup tolerates an iframe becoming inaccessible after navigation.

`saves.svelte.ts` preserves synchronous chooser invocation from the game's direct
parent call, rejects duplicate transfers without unlocking the original chooser,
and returns an immediate boolean from `allbyteRequestImport()`. It emits protocol-2
`allbyte:native-file-prompt` messages with sessionId, promptId, kind `import`, phase
`opening`/`returned`, and outcome `pending`/`selected`/`cancelled`/`returned`/`error`.
Each attempt reports return once; a focus-based `returned` is not a final import
result. Existing durable game acknowledgment still gates save mirror/cloud updates.
The test hook teardown is now development-gated as well as its installation.

`GodotEmbed.svelte` now owns balanced visibility/focus/page lifecycle notification,
including desktop blur followed by focus without visibilitychange. Entering the
iframe does not pause the game. Chooser-related fullscreen exits are distinguished
from intentional exits through the next trusted interaction; recovery re-arms
gesture-based entry and respects an existing fullscreen opt-out. It does not force
focus into the canvas or request fullscreen during the chooser gesture.

The corrected analysis is in `NATIVE_PROMPTS_AND_CURSOR_HANDOFF.md`. Browser
activation is transient rather than strictly limited to one synchronous task;
nevertheless the direct synchronous call is the reliable integration path here.
Downloads have no portable modal lifetime signal.

## Validation

- 25 Node tests passed: transfer protocol/cloud regression checks and ten native
  lifecycle/visibility checks. Run `npm run test:saves`.
- TypeScript `tsc --noEmit` passed.
- Five Chromium browser adapter checks passed against an isolated local dev server:
  protocol negotiation, unrelated-snapshot rejection, actual download, actual file
  chooser plus durable successful import, and failed import preserving the mirror.
  The fixture now supplies the required iframe embedder policy and creates a new
  session ID per document load. Earlier fixture startup failures were resolved.
- Astro production build passed (62 pages). The built client assets contain
  neither the save test hook nor the development source-check bypass.

These browser tests use a simulated same-origin game. They do not prove real OS
cancel behavior, Godot cursor/input restoration, mobile Safari or controller-driven
activation. The isolated local dev server was stopped after browser validation.

## Rowan's remaining game work

The GameDev handoff gives the precise additive message contract and acceptance
matrix. Rowan must capture cursor/input/menu/pause state BEFORE the synchronous
parent call, honor its boolean return, balance restoration once, release held input,
consume the initiating accept, and handle scene/menu replacement safely. Async
postMessage notification cannot prepare the game before a native dialog appears.
Replace raw Godot Window dialogs with themed main-viewport menus, retaining overwrite
confirmation and usable error feedback while removing modal export-success notices.

App and Rowan should validate the exported Godot build together: real chooser
selection/cancel/retry, cursor and focus recovery, held keys, mouse/touch/controller
navigation, fullscreen preference, unchanged saves on cancel/failure, and an actual
export/import/reload round trip. Broader cloud quota/conflict UI and deployment
decisions from the previous save-transfer review remain separate release work.
