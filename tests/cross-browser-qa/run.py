"""Cross-browser-engine smoke harness for /play/.

Boots Chronicles of Nesis in Chromium + Firefox + Webkit (Safari's engine,
not actual Safari), waits for the Title scene, captures a screenshot per
engine + the iframe's _consoleLogs, and flags suspicious lines (missing
asset / shader compile / gzip decompression failures).

The point isn't pixel-diff yet (that's v1). The point is:
  - confirm each engine even reaches Title
  - catch engine-class console errors that single-browser CI misses
  - capture screenshots side-by-side so visual regressions are spottable

Usage:
  pip install playwright
  playwright install chromium firefox webkit

  python tests/cross-browser-qa/run.py                       # all three engines, prod
  python tests/cross-browser-qa/run.py --target local        # against localhost:4321
  python tests/cross-browser-qa/run.py --engines chromium,firefox
  python tests/cross-browser-qa/run.py --headed              # default is headless

Reports: tests/cross-browser-qa/reports/<timestamp>/
  - <engine>.png       — Title-scene screenshot per engine
  - <engine>.logs.txt  — iframe _consoleLogs at the moment of capture
  - results.json       — pass/fail summary + flagged log lines
  - report.md          — human-readable side-by-side summary

Exit code:
  0 — all engines booted, no suspect log patterns
  1 — at least one engine had a suspect log pattern (gzip, shader, etc.)
  2 — at least one engine failed to reach Title within timeout
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = Path(__file__).parent
REPORTS_DIR = BASE / "reports"

TARGET_URLS = {
    "prod": "https://allbyte.studio/play/",
    "local": "http://localhost:4321/play/",
}

ENGINES = ["chromium", "firefox", "webkit"]

# Log patterns that indicate something rendered wrong even if the game
# kept running. These are SEPARATE from the smoke-test "fatal" patterns
# (MD5 mismatch, encrypted file failures) — those are catastrophic; these
# are silently-degrade warnings where the engine keeps going but assets
# are missing.
SUSPECT_PATTERNS = [
    "core io stream peer gzip failed",   # the one Drew saw on MBA
    "StreamPeerGZIP",                     # variants of the same
    "Failed to compile shader",
    "Shader compilation failed",
    "shader translation",
    "out of memory",
    "Out of memory",
    "WebGL: INVALID_OPERATION",
    "WebGL: GL_OUT_OF_MEMORY",
    "Texture upload failed",
    "Failed to load resource",
]

# Hard-fatal patterns — same as smoke_prod.py. If any engine hits these,
# the smoke is failed at the smoke level.
FATAL_PATTERNS = [
    "MD5 sum of the decrypted file does not match",
    "Can't open encrypted pack-referenced file",
    "ERROR: open_and_parse",
    "Cannot get class",
]

BOOT_TIMEOUT_S = 60
READY_POLL_S = 1


def test_engine(p, engine_name: str, target_url: str, headless: bool, out_dir: Path) -> dict:
    """Boot /play/ in a single engine, capture state, return result."""
    print(f"  [{engine_name}] launching...", flush=True)

    if engine_name == "chromium":
        browser = p.chromium.launch(headless=headless)
    elif engine_name == "firefox":
        browser = p.firefox.launch(headless=headless)
    elif engine_name == "webkit":
        browser = p.webkit.launch(headless=headless)
    else:
        raise ValueError(f"Unknown engine: {engine_name}")

    try:
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        page = context.new_page()

        # Capture page-level console + errors
        page_events: list[str] = []
        page.on("console", lambda m: page_events.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: page_events.append(f"[page-error] {e}"))

        try:
            page.goto(target_url, wait_until="domcontentloaded", timeout=30_000)
        except Exception as e:
            return {
                "engine": engine_name,
                "status": "navigation_failed",
                "error": str(e),
                "page_events": page_events,
            }

        # Wait for iframe to mount
        try:
            iframe_handle = page.wait_for_selector("iframe", timeout=15_000)
        except Exception:
            return {
                "engine": engine_name,
                "status": "no_iframe",
                "page_events": page_events,
            }

        iframe = iframe_handle.content_frame()
        if iframe is None:
            return {
                "engine": engine_name,
                "status": "iframe_no_frame",
                "page_events": page_events,
            }

        # Capture iframe-level console + errors too
        iframe.on("console", lambda m: page_events.append(f"[iframe:{m.type}] {m.text}"))
        iframe.on("pageerror", lambda e: page_events.append(f"[iframe-error] {e}"))

        # Wait for Godot to boot to a scene. gameState lives on the iframe's
        # window (same pattern as scripts/smoke_prod.py).
        scene = None
        elapsed = 0
        while elapsed < BOOT_TIMEOUT_S:
            page.wait_for_timeout(READY_POLL_S * 1000)
            elapsed += READY_POLL_S
            try:
                scene = iframe.evaluate("window.gameState?.scene || null")
            except Exception:
                scene = None
            if scene:
                break

        if not scene:
            screenshot_path = out_dir / f"{engine_name}.png"
            page.screenshot(path=str(screenshot_path), full_page=False)
            return {
                "engine": engine_name,
                "status": "boot_timeout",
                "elapsed_s": elapsed,
                "page_events": page_events,
                "screenshot": screenshot_path.name,
            }

        print(f"  [{engine_name}] booted to {scene} in {elapsed}s", flush=True)

        # Capture _consoleLogs from inside the iframe (the index.html
        # ARC-DEV-CONSOLE interceptor mirrors all GDScript print() and
        # error output there).
        iframe_logs: list[str] = []
        try:
            raw = iframe.evaluate("(window._consoleLogs || []).slice(-200)")
            iframe_logs = [str(x) for x in (raw or [])]
        except Exception as e:
            iframe_logs = [f"[harness] failed to read _consoleLogs: {e}"]

        # Give the engine a beat to render the scene before snapshotting
        page.wait_for_timeout(1500)

        screenshot_path = out_dir / f"{engine_name}.png"
        page.screenshot(path=str(screenshot_path), full_page=False)

        # Write the iframe logs to disk too — the JSON report only carries
        # the suspect-matching subset; full log is on disk for forensic
        # review.
        (out_dir / f"{engine_name}.logs.txt").write_text("\n".join(iframe_logs))

        # Classify logs
        fatal_hits = [l for l in iframe_logs if any(p in l for p in FATAL_PATTERNS)]
        suspect_hits = [
            l for l in iframe_logs
            if any(p in l for p in SUSPECT_PATTERNS)
            and not any(p in l for p in FATAL_PATTERNS)
        ]

        return {
            "engine": engine_name,
            "status": "ok",
            "scene": scene,
            "boot_elapsed_s": elapsed,
            "screenshot": screenshot_path.name,
            "iframe_log_count": len(iframe_logs),
            "fatal_log_count": len(fatal_hits),
            "suspect_log_count": len(suspect_hits),
            "fatal_samples": fatal_hits[:10],
            "suspect_samples": suspect_hits[:20],
            "page_event_count": len(page_events),
        }

    finally:
        browser.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Cross-browser-engine smoke for /play/")
    ap.add_argument("--target", default="prod", help="prod | local | full URL")
    ap.add_argument(
        "--engines",
        default=",".join(ENGINES),
        help="Comma-separated subset of chromium,firefox,webkit",
    )
    ap.add_argument("--headed", action="store_true", help="Run headed (default: headless)")
    args = ap.parse_args()

    target_url = TARGET_URLS.get(args.target, args.target)
    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    for e in engines:
        if e not in ENGINES:
            print(f"ERROR: unknown engine '{e}' (valid: {ENGINES})", file=sys.stderr)
            return 2

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out_dir = REPORTS_DIR / timestamp
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Target: {target_url}")
    print(f"Engines: {engines}")
    print(f"Output: {out_dir}")
    print()

    results: list[dict] = []
    with sync_playwright() as p:
        for engine in engines:
            try:
                r = test_engine(p, engine, target_url, not args.headed, out_dir)
            except Exception as e:
                r = {"engine": engine, "status": "exception", "error": str(e)}
            results.append(r)

    # Write JSON + markdown reports
    (out_dir / "results.json").write_text(
        json.dumps(
            {"timestamp": timestamp, "target": target_url, "results": results},
            indent=2,
        )
    )
    write_markdown(out_dir / "report.md", target_url, timestamp, results)

    # Summary
    print()
    print("=== Summary ===")
    any_boot_failed = False
    any_suspect = False
    for r in results:
        if r["status"] != "ok":
            any_boot_failed = True
            print(f"  [{r['engine']}] FAIL — {r['status']}: {r.get('error', '')}")
        else:
            mark = "OK"
            extras = []
            if r["fatal_log_count"] > 0:
                mark = "FAIL"
                any_boot_failed = True
                extras.append(f"{r['fatal_log_count']} fatal")
            if r["suspect_log_count"] > 0:
                if mark == "OK":
                    mark = "SUSPECT"
                any_suspect = True
                extras.append(f"{r['suspect_log_count']} suspect")
            extras_str = f" — {', '.join(extras)}" if extras else ""
            print(
                f"  [{r['engine']}] {mark}: scene={r['scene']}, "
                f"booted in {r['boot_elapsed_s']}s, logs={r['iframe_log_count']}"
                f"{extras_str}"
            )

    print()
    print(f"Report: {out_dir / 'report.md'}")
    print(f"JSON:   {out_dir / 'results.json'}")
    print(f"PNGs:   {out_dir}")

    if any_boot_failed:
        return 2
    if any_suspect:
        return 1
    return 0


def write_markdown(path: Path, target: str, timestamp: str, results: list[dict]) -> None:
    lines: list[str] = []
    lines.append("# Cross-Browser QA Run")
    lines.append("")
    lines.append(f"- **Timestamp:** {timestamp}")
    lines.append(f"- **Target:** `{target}`")
    lines.append("")
    lines.append("## Per-engine summary")
    lines.append("")
    lines.append("| Engine | Status | Scene | Boot time | Logs | Fatal | Suspect |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in results:
        if r["status"] == "ok":
            lines.append(
                f"| {r['engine']} | OK | {r['scene']} | {r['boot_elapsed_s']}s | "
                f"{r['iframe_log_count']} | {r['fatal_log_count']} | "
                f"{r['suspect_log_count']} |"
            )
        else:
            lines.append(
                f"| {r['engine']} | {r['status']} | — | — | — | — | — |"
            )

    lines.append("")
    lines.append("## Screenshots")
    lines.append("")
    for r in results:
        if r.get("screenshot"):
            lines.append(f"### {r['engine']}")
            lines.append("")
            lines.append(f"![{r['engine']}]({r['screenshot']})")
            lines.append("")

    # Detail any suspect/fatal hits
    any_flagged = any(
        r.get("fatal_log_count", 0) > 0 or r.get("suspect_log_count", 0) > 0
        for r in results
        if r["status"] == "ok"
    )
    if any_flagged:
        lines.append("## Flagged log lines")
        lines.append("")
        for r in results:
            if r["status"] != "ok":
                continue
            if r["fatal_log_count"] == 0 and r["suspect_log_count"] == 0:
                continue
            lines.append(f"### {r['engine']}")
            lines.append("")
            for sample in r.get("fatal_samples", []):
                lines.append(f"- **FATAL:** `{sample}`")
            for sample in r.get("suspect_samples", []):
                lines.append(f"- suspect: `{sample}`")
            lines.append("")

    lines.append("")
    lines.append("## What this catches")
    lines.append("")
    lines.append(
        "- **Engine-class regressions** — assets that render on chromium "
        "but vanish on firefox/webkit, or vice versa."
    )
    lines.append(
        "- **Silent decompression failures** like the "
        "`core io stream peer gzip failed` Drew hit on MacBook Air "
        "(2026-06-03). Symptom is missing-but-not-crashing assets; this "
        "harness surfaces the log line."
    )
    lines.append(
        "- **Shader / WebGL warnings** that single-browser smoke would "
        "miss because chromium's behavior is the most permissive."
    )
    lines.append("")
    lines.append("## What this does NOT catch")
    lines.append("")
    lines.append(
        "- **Mac-Chrome-specific bugs** — Playwright's `webkit` is "
        "Safari's engine, NOT Chrome on Mac. Chrome-on-Mac goes through "
        "ANGLE → Metal, which is a unique stack. To catch those, run this "
        "harness on a real Mac, or add a macos-latest matrix entry in CI."
    )
    lines.append(
        "- **Real-device differences** — iOS Safari, Android Chrome, etc. "
        "all have their own quirks not represented in Playwright's "
        "headless engines."
    )

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
