# Controller QA Harness

Automated check that the application correctly receives Gamepad-API
events for every major controller type — Xbox, PlayStation, Switch Pro,
Steam Deck, generic — without owning each physically.

Works by mocking the browser's `navigator.getGamepads()` API directly in
the page via Playwright's `addInitScript()`. Skips the kernel-driver
layer entirely. See `~/.claude/plans/controller-qa-harness-research.md`
for the architecture decisions and what this approach can / can't test.

## Setup (one-time)

```
pip install playwright
playwright install chromium
```

That's it — no kernel drivers required.

## Usage

```
# Run against the local tester.html (default — sanity check the harness itself)
python tests/controller-qa/run_qa.py

# Run against local dev server (must have `npm run dev` running)
python tests/controller-qa/run_qa.py --target local

# Run against production
python tests/controller-qa/run_qa.py --target prod

# Run only specific controller profiles (comma-separated slugs)
python tests/controller-qa/run_qa.py --controllers xbox-360-controller,dualsense-ps5

# Run headless (default is headed; gamepad API is sometimes flaky headless)
python tests/controller-qa/run_qa.py --headless
```

Or via npm:

```
npm run qa:controllers              # default: tester.html
npm run qa:controllers -- --target=prod
```

Reports are written to `tests/controller-qa/reports/<timestamp>/`:

- `results.json` — full raw output
- `report.md` — human-readable summary table + failure details

## Files

- **`tester.html`** — standalone page that listens to the Gamepad API
  and renders state in DOM-readable form (`data-button=`, `data-pressed=`,
  `data-axis=`, `data-value=`). Use this as the harness target to
  sanity-check the harness mechanics independent of the real game.
- **`controllers.json`** — controller profiles. Vendor / product IDs,
  button counts, axis counts, button name mappings. Drives what gets
  injected and what's verified.
- **`mock_gamepad.js`** — Playwright init script. Overrides
  `navigator.getGamepads()` and exposes `window.__qaInstallMock`,
  `__qaSetButton`, `__qaSetAxis`, `__qaDisconnect`, `__qaGetMockState`.
- **`run_qa.py`** — Python orchestrator. Loops profiles × buttons ×
  axes, captures DOM state after each input, generates the report.

## Adding a controller profile

Append an object to `controllers.json` with this shape:

```json
{
  "name": "Some Controller",
  "id": "Some Controller (STANDARD GAMEPAD Vendor: XXXX Product: YYYY)",
  "vendorId": "XXXX",
  "productId": "YYYY",
  "mapping": "standard",
  "numButtons": 17,
  "numAxes": 4,
  "buttonNames": { "0": "...", "1": "...", ... }
}
```

The `id` string is what the application sees via `gamepad.id` — keep it
realistic (look at https://gamepad-tester.com/ with the real controller
to copy the actual `id` if you have access). `mapping: "standard"`
means the page can use the standard button index layout (A=0, B=1,
etc.); set `""` or `"vendor-specific"` if you want to test a non-standard
mapping path.

## What this harness can't test

- **OS-driver layer.** If a real DualSense isn't recognized by Chrome
  for some browser-specific reason, the harness won't catch that.
  Real-hardware sanity check needed once per controller for that.
- **Vendor-specific extensions.** DualSense haptics, adaptive triggers,
  DS4 gyro — these don't go through the standard Gamepad API the
  harness mocks.
- **Real-world latency / jitter / debounce behavior.**

## What it CAN test

- Whether the game (or any web page) correctly responds to every
  button index for every controller type
- Whether the axes respond to the expected -1 to +1 range
- Whether the gamepad shows up at all (`gamepadconnected` event fires,
  `navigator.getGamepads()` returns the mock)
- Whether the application handles the vendor ID / mapping string for
  each controller type

## Steam Deck note

The Steam Deck typically presents to apps as an Xbox-style virtual
controller via Steam Input. The native trackpads, gyro, and back
paddles are NOT exposed via the standard Web Gamepad API — they go
through Steam Input on desktop or kernel evdev on Linux. The profile
in `controllers.json` reflects the standard xinput passthrough only.
Real Deck hardware is required to test the Steam Input layer.

## Test against the live game

`--target=local` and `--target=prod` route at `/play/` and auto-detect
"play mode" — the harness waits for Godot to boot to a real scene (via
`window.gameState.scene` polling on the iframe context, same pattern as
`scripts/smoke_prod.py`), clicks the iframe to register user activation,
and injects the mock into the iframe's window before each profile sweep.

```
python tests/controller-qa/run_qa.py --target prod
```

Expect ~30s per profile on cold cache (Godot WASM compile + PCK download),
~5s warm. Full 7-controller sweep against prod takes ~3 minutes.

### Verification semantics in play mode

- **What the harness verifies:** mock injection succeeds in the iframe;
  per-input round-trip via `window.__qaGetMockState()`; the game
  survives the full sweep (`gameState.scene` still set after sweep, no
  fatal errors in `_consoleLogs`).
- **What it CANNOT verify yet:** whether Chronicles' InputMap actually
  fired the corresponding action in response. That requires game-side
  instrumentation — Arc adds a debug print on every InputAction firing,
  harness greps `_consoleLogs` for those. Coord doc to Arc:
  `Desktop\GameDev\APP_CLAUDE_CONTROLLER_INPUTMAP_AUDIT.md`.
- **Fatal vs informational logs:** Godot's GDScript runtime logs
  verbose `ERROR:`-prefixed lines for many non-fatal conditions (Parse
  JSON failed, etc.). The harness classifies those as informational
  (count visible in the report, doesn't fail the test). Only genuine
  crashers — MD5 mismatches, encrypted file failures, missing classes,
  uncaught JS exceptions — flip status to PARTIAL.

### Known Godot HTML5 quirk

Godot's HTML5 runtime detaches the iframe after ~2 mock connect /
disconnect cycles. Cause not fully understood, possibly internal
teardown reacting to repeated `gamepadconnected` events. Harness
workaround: reload the page between profiles in play mode (each profile
starts from a fresh Godot boot). This is mentioned for transparency —
the workaround makes the QA pipeline reliable but the underlying cause
is worth investigating game-side eventually.
