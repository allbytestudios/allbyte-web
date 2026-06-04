# Cross-Browser QA Harness

Boots Chronicles of Nesis on `/play/` in **Chromium + Firefox + Webkit**
(Safari's engine, not actual Safari), waits for the Title scene, captures
a screenshot per engine + the iframe's `_consoleLogs`, and flags
suspicious lines.

Purpose: catch engine-class regressions that single-browser smoke
testing misses. Origin: Drew hit `core io stream peer gzip failed` on
MacBook Air Chrome on 2026-06-03 with silently-missing background hills,
which the existing Windows-Chromium-only smoke test never flagged.

## Setup (one-time)

```
pip install playwright
playwright install chromium firefox webkit
```

The first time, Playwright downloads each browser engine (~400 MB total).

## Usage

```
# All three engines against prod (default)
python tests/cross-browser-qa/run.py

# Against local dev server (must have `npm run dev` running)
python tests/cross-browser-qa/run.py --target local

# Subset of engines
python tests/cross-browser-qa/run.py --engines chromium,firefox

# Headed mode (for visual debugging — slower)
python tests/cross-browser-qa/run.py --headed
```

Or via npm:

```
npm run qa:browsers                          # default: prod, all engines
npm run qa:browsers -- --target=local
npm run qa:browsers -- --engines=chromium
```

Reports land in `tests/cross-browser-qa/reports/<timestamp>/`:

- `<engine>.png` — Title-scene screenshot per engine
- `<engine>.logs.txt` — full iframe `_consoleLogs` (last 200 lines) per engine
- `results.json` — pass/fail + flagged-line summary
- `report.md` — human-readable side-by-side summary with embedded images

## What gets flagged

**Fatal** (any of these → exit code 2):

- `MD5 sum of the decrypted file does not match` — broken PCK
- `Can't open encrypted pack-referenced file` — encryption issue
- `ERROR: open_and_parse` — encrypted file open failure
- `Cannot get class` — missing pack template

**Suspect** (any of these → exit code 1, but didn't crash the engine):

- `core io stream peer gzip failed` — StreamPeerGZIP decompression failure (the symptom Drew hit; manifests as silently-missing assets)
- `StreamPeerGZIP` — variant of the above
- `Failed to compile shader` / `Shader compilation failed` — engine-side shader translation failure
- `shader translation` — generic shader translation issue
- `out of memory` / `Out of memory` — buffer allocation failure
- `WebGL: INVALID_OPERATION` / `WebGL: GL_OUT_OF_MEMORY` — WebGL state error
- `Texture upload failed` — GPU texture upload failure
- `Failed to load resource` — network or path issue

Add new patterns to `SUSPECT_PATTERNS` in `run.py` as you find them.

## What this catches

- **Engine-class regressions** — assets that render on Chromium but vanish on Firefox/Webkit, or vice versa
- **Silent decompression failures** — `gzip failed` style log lines that
  result in "the hills are missing" symptoms without crashing the game
- **Shader / WebGL warnings** — Chromium is the most permissive engine;
  Firefox and Webkit catch issues Chromium happily ignores

## What this does NOT catch

- **Mac-Chrome-specific bugs.** Playwright's `webkit` is Safari's engine,
  NOT Chrome on Mac. Chrome on Mac goes through ANGLE → Metal, which is a
  unique stack. To catch those, run this harness on a real Mac, or add a
  `macos-latest` matrix entry in CI.
- **Real-device differences.** iOS Safari, Android Chrome, Steam Deck
  browser etc. have their own quirks not represented in Playwright's
  headless engines.
- **Single-scene only (today).** This harness only loads to the Title
  scene. Missing-hill issues that happen on Laria-Waterway1 wouldn't be
  caught unless we extend the harness to traverse multiple scenes via the
  fixture-load protocol. That's v1.

## Roadmap

- **v0 (this):** Title-scene smoke across 3 engines. Catches "engine doesn't
  even boot" and Title-scene-visible suspect log patterns.
- **v1:** Multi-scene traversal via fixture loading. Load a save fixture
  per scene of interest, screenshot, scrape `_consoleLogs`. Likely needs
  ~5-10 scenes covered: Title, Laria-MainSquare, Laria-Waterway1, etc.
- **v2:** Pixel-diff against baseline screenshots. Catches missing-asset
  regressions visually — if the hills are gone on Webkit but present on
  Chromium, the pixel-diff will flag it without needing a specific log
  pattern.
- **v3 (when justified):** GitHub Actions matrix — ubuntu + windows +
  macos runners running this harness nightly. Free for public repos, 2000
  free minutes/mo for private.

## Running on Mac

To repro Drew's MacBook Air gzip issue, run this on a Mac:

```
python tests/cross-browser-qa/run.py --engines=chromium --target=prod
```

The `chromium` engine on Mac runs through ANGLE → Metal — the same code
path as Chrome on Mac. The harness will surface the `gzip failed` log
line if it recurs. Compare the screenshot against a Windows-chromium
baseline to see what's actually missing.
