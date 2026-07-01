"""Cross-browser-engine gameplay QA harness for Chronicles of Nesis.

Runs two things per engine (Chromium + Firefox + Webkit — Safari's engine,
not actual Safari):

  1. /play/ EMBED SMOKE (real user path) — load /play/, click through the
     download gate, and confirm the game iframe mounts and boots to a scene.
  2. PUBLIC-BUILD GAMEPLAY — on the gate-free /godot/public/ build, drive the
     three things a player must be able to do, via Quinn's hook-based
     game_driver (tests/e2e/game_driver.py — NO keyboard):
       BOOT     — reaches the Title screen
       NEW GAME — start_new_game() leaves Title and loads the Laria pack
       MOVEMENT — assert_controls() imports EliasHouse and a held direction
                  moves the player (playerX/Y changes)

Also captures the iframe + game console logs and flags suspicious lines
(missing asset / shader compile / gzip decompression / decryption failures).

Usage:
  pip install playwright
  playwright install chromium firefox webkit

  python tests/cross-browser-qa/run.py                       # all three engines, prod
  python tests/cross-browser-qa/run.py --target local        # against localhost:4321
  python tests/cross-browser-qa/run.py --engines chromium,firefox
  python tests/cross-browser-qa/run.py --headed              # default is headless

Reports: tests/cross-browser-qa/reports/<timestamp>/
  - <engine>.png       — /play/ screenshot per engine
  - <engine>.logs.txt  — combined iframe + public-build console logs
  - results.json       — per-engine status + stages{boot,new_game,movement} + play_embed
  - report.md          — human-readable side-by-side summary

Exit code:
  0 — every engine: /play/ booted, all gameplay stages passed, no suspect logs
  1 — otherwise-passing, but at least one engine had a suspect log pattern
  2 — at least one engine failed the /play/ boot or a gameplay stage
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

# Reuse Quinn's proven, hook-driven game driver (tests/e2e/game_driver.py) for
# the NEW GAME + MOVEMENT stages — no keyboard, so a real input failure can't be
# confused with a Playwright keyboard quirk. Verified across all 3 engines.
sys.path.insert(0, str((BASE.parent / "e2e").resolve()))
from game_driver import start_new_game, assert_controls, _wait  # noqa: E402

# The real user path (iframe + COEP + download gate).
TARGET_URLS = {
    "prod": "https://allbyte.studio/play/",
    "local": "http://localhost:4321/play/",
}
# The gate-free, top-level public build the game driver drives (window.gameState
# is reachable directly — no iframe hop).
PUBLIC_URLS = {
    "prod": "https://allbyte.studio/godot/public/index.html",
    "local": "http://localhost:4321/godot/public/index.html",
}

ENGINES = ["chromium", "firefox", "webkit"]

# Log patterns that indicate something rendered wrong even if the game
# kept running. These are SEPARATE from the smoke-test "fatal" patterns
# (MD5 mismatch, encrypted file failures) — those are catastrophic; these
# are silently-degrade warnings where the engine keeps going but assets
# are missing.
SUSPECT_PATTERNS = [
    "core io stream peer gzip failed",   # the one the owner saw on MBA
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
NAV_ATTEMPTS = 3


def _launch(p, engine_name: str, headless: bool):
    if engine_name == "chromium":
        # swiftshader so a headless CI runner / GPU-less box still gets a WebGL
        # context — the engine needs it to render and to actually move the
        # player in the MOVEMENT stage.
        return p.chromium.launch(
            headless=headless,
            args=[
                "--use-gl=swiftshader",
                "--enable-unsafe-swiftshader",
                "--ignore-gpu-blocklist",
            ],
        )
    if engine_name in ("firefox", "webkit"):
        return getattr(p, engine_name).launch(headless=headless)
    raise ValueError(f"Unknown engine: {engine_name}")


def _goto_retry(page, url: str, attempts: int = NAV_ATTEMPTS) -> bool:
    """Navigate, retrying transient 5xx. The QA races the deploy's CloudFront
    invalidation — freshly-hashed bundles can 503 for a few seconds."""
    for _ in range(attempts):
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            if resp is None or resp.status < 500:
                return True
        except Exception:
            pass
        page.wait_for_timeout(3000)
    return False


def _play_embed(context, play_url: str, out_dir: Path, engine_name: str) -> dict:
    """Real user path: /play/ → click through the download gate → the game
    iframe mounts and boots to a scene. Returns status + scene + iframe logs."""
    page = context.new_page()
    events: list[str] = []
    page.on("console", lambda m: events.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: events.append(f"[page-error] {e}"))

    if not _goto_retry(page, play_url):
        return {"status": "navigation_failed", "scene": None, "logs": [], "screenshot": None}

    # Fresh browser → the download gate holds the iframe until "Continue". Click
    # it. If it's absent (already acked / suppressed) the iframe renders anyway.
    try:
        page.wait_for_selector(".dl-go", timeout=8_000)
        page.click(".dl-go")
    except Exception:
        pass

    try:
        handle = page.wait_for_selector("iframe", timeout=15_000)
        iframe = handle.content_frame()
    except Exception:
        iframe = None
    if iframe is None:
        return {"status": "no_iframe", "scene": None, "logs": [], "screenshot": None}

    iframe.on("console", lambda m: events.append(f"[iframe:{m.type}] {m.text}"))

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

    logs: list[str] = []
    try:
        raw = iframe.evaluate("(window._consoleLogs || []).slice(-200)")
        logs = [str(x) for x in (raw or [])]
    except Exception:
        pass

    page.wait_for_timeout(1200)
    shot = out_dir / f"{engine_name}.png"
    try:
        page.screenshot(path=str(shot), full_page=False)
        shot_name = shot.name
    except Exception:
        shot_name = None

    # Close the /play/ page so its running WebGL game doesn't compete for
    # network/CPU with the public-build gameplay checks (the ~43 MB Laria pack
    # New Game pulls would otherwise race the still-open iframe past its timeout).
    try:
        page.close()
    except Exception:
        pass

    return {
        "status": "ok" if scene else "boot_timeout",
        "scene": scene,
        "boot_elapsed_s": elapsed if scene else None,
        "logs": logs,
        "screenshot": shot_name,
    }


def _public_gameplay(context, public_url: str) -> tuple[dict, list[str]]:
    """Gate-free public build: BOOT (reach Title) → NEW GAME (start_new_game)
    → MOVEMENT (assert_controls). Hook-driven via game_driver. Returns the
    stage verdicts + the game's console logs for classification."""
    stages = {"boot": "fail", "new_game": "fail", "movement": "fail"}
    logs: list[str] = []

    # BOOT + NEW GAME share a page (New Game starts from Title). Only one game
    # runs at a time — close each page before the next so the big pack downloads
    # don't contend (that contention is what fails an otherwise-good New Game).
    p1 = context.new_page()
    if _goto_retry(p1, public_url) and _wait(p1, lambda s: s.get("ready"), 60):
        if _wait(p1, lambda s: s.get("scene") == "Title", 60):
            stages["boot"] = "pass"
            if start_new_game(p1):
                stages["new_game"] = "pass"
    try:
        raw = p1.evaluate("(window._consoleLogs || []).slice(-200)")
        logs = [str(x) for x in (raw or [])]
    except Exception:
        pass
    try:
        p1.close()
    except Exception:
        pass

    # MOVEMENT on a fresh page — assert_controls imports its own EliasHouse save
    # and force-loads it, independent of the New-Game run above.
    p2 = context.new_page()
    if _goto_retry(p2, public_url) and _wait(p2, lambda s: s.get("ready"), 60):
        if assert_controls(p2):
            stages["movement"] = "pass"
    try:
        p2.close()
    except Exception:
        pass

    return stages, logs


def test_engine(
    p, engine_name: str, play_url: str, public_url: str, headless: bool, out_dir: Path
) -> dict:
    """Run the full per-engine QA: the /play/ embed smoke (real user path) plus
    the public-build BOOT → NEW GAME → MOVEMENT gameplay stages."""
    print(f"  [{engine_name}] launching...", flush=True)
    browser = _launch(p, engine_name, headless)
    try:
        # Separate contexts so the /play/ embed and the public gameplay runs are
        # fully isolated (no shared localStorage ack, no lingering WebGL game).
        ctx1 = browser.new_context(viewport={"width": 1280, "height": 900})
        embed = _play_embed(ctx1, play_url, out_dir, engine_name)
        print(f"  [{engine_name}] /play/ embed: {embed['status']} scene={embed['scene']}", flush=True)
        try:
            ctx1.close()
        except Exception:
            pass

        ctx2 = browser.new_context(viewport={"width": 1280, "height": 900})
        stages, pub_logs = _public_gameplay(ctx2, public_url)
        try:
            ctx2.close()
        except Exception:
            pass
        print(
            f"  [{engine_name}] public: boot={stages['boot']} "
            f"new_game={stages['new_game']} movement={stages['movement']}",
            flush=True,
        )

        # Classify logs from BOTH the /play/ iframe and the public build.
        all_logs = (embed.get("logs") or []) + (pub_logs or [])
        (out_dir / f"{engine_name}.logs.txt").write_text("\n".join(all_logs))
        fatal = [l for l in all_logs if any(x in l for x in FATAL_PATTERNS)]
        suspect = [
            l for l in all_logs
            if any(x in l for x in SUSPECT_PATTERNS)
            and not any(x in l for x in FATAL_PATTERNS)
        ]

        stages_ok = all(v == "pass" for v in stages.values())
        overall = "ok" if (embed["status"] == "ok" and stages_ok and not fatal) else "failed"

        return {
            "engine": engine_name,
            "status": overall,
            "scene": embed.get("scene"),
            "boot_elapsed_s": embed.get("boot_elapsed_s"),
            "stages": stages,
            "play_embed": {"status": embed["status"], "scene": embed.get("scene")},
            "screenshot": embed.get("screenshot"),
            "iframe_log_count": len(all_logs),
            "fatal_log_count": len(fatal),
            "suspect_log_count": len(suspect),
            "fatal_samples": fatal[:10],
            "suspect_samples": suspect[:20],
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
    public_url = PUBLIC_URLS.get(args.target) or target_url.replace(
        "/play/", "/godot/public/index.html"
    )
    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    for e in engines:
        if e not in ENGINES:
            print(f"ERROR: unknown engine '{e}' (valid: {ENGINES})", file=sys.stderr)
            return 2

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out_dir = REPORTS_DIR / timestamp
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Target (/play/): {target_url}")
    print(f"Public build:    {public_url}")
    print(f"Engines: {engines}")
    print(f"Output: {out_dir}")
    print()

    results: list[dict] = []
    with sync_playwright() as p:
        for engine in engines:
            try:
                r = test_engine(p, engine, target_url, public_url, not args.headed, out_dir)
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
        st = r.get("stages") or {}
        pe = (r.get("play_embed") or {}).get("status", "?")
        stage_str = (
            f"play={pe} boot={st.get('boot','?')} "
            f"new_game={st.get('new_game','?')} movement={st.get('movement','?')}"
        )
        if r["status"] != "ok":
            any_boot_failed = True
            err = r.get("error")
            print(f"  [{r['engine']}] FAIL — {stage_str}" + (f" ({err})" if err else ""))
        else:
            mark = "OK"
            extras = []
            if r.get("suspect_log_count", 0) > 0:
                mark = "SUSPECT"
                any_suspect = True
                extras.append(f"{r['suspect_log_count']} suspect")
            extras_str = f" — {', '.join(extras)}" if extras else ""
            print(f"  [{r['engine']}] {mark}: {stage_str}{extras_str}")

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
    lines.append("| Engine | Status | /play/ | Boot | New Game | Movement | Fatal | Suspect |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for r in results:
        st = r.get("stages") or {}
        pe = (r.get("play_embed") or {}).get("status", "—")
        lines.append(
            f"| {r['engine']} | {r['status']} | {pe} | {st.get('boot','—')} | "
            f"{st.get('new_game','—')} | {st.get('movement','—')} | "
            f"{r.get('fatal_log_count', 0)} | {r.get('suspect_log_count', 0)} |"
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
        "`core io stream peer gzip failed` the owner hit on MacBook Air "
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
