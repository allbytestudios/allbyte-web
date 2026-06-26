"""
Post-deploy smoke test for /play/ on production.

What it catches that the existing smoke (`gameState.version`) does NOT:
the engine actually booting against the PCK. The 2026-06-01 black screen
slipped through because `current_version.txt` loads over the network
independent of the PCK — so the version stamp was correct while every
encrypted resource in the PCK was failing MD5. This script waits for the
Godot engine to actually boot, then scrapes `window._consoleLogs` (the
ARC-DEV-CONSOLE interceptor in index.html) for the canonical Godot
failure signatures.

Run automatically by `npm run push-assets` after the CloudFront
invalidation step. Skip with `SKIP_SMOKE=1` (e.g., for routine asset-only
deploys where you're confident nothing about the game changed).

Override target via SMOKE_URL env var (default https://allbyte.studio/play/).

Exit codes:
  0  no errors detected
  1  one or more suspect log lines found, or the game never became ready
"""

import os
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[smoke] playwright not installed; `pip install playwright && playwright install chromium`")
    sys.exit(1)

URL = os.environ.get("SMOKE_URL", "https://allbyte.studio/play/")
BOOT_TIMEOUT_S = 45  # generous; first-load with cold cache is slow
READY_POLL_S = 1

# Godot stderr lines that indicate a deploy-breaking failure.
SUSPECT_PATTERNS = [
    "MD5 sum of the decrypted file does not match",
    "Can't open encrypted pack-referenced file",
    "Cannot get class",  # missing pack template
    "ERROR: open_and_parse",  # encrypted file open failure
]


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        # /play now gates the ~100 MB first load behind a consent notice that
        # withholds the game iframe until the user clicks Continue (remembered
        # per-device). Pre-acknowledge so the smoke emulates a returning/
        # consented user and the iframe actually mounts. add_init_script runs
        # before page scripts on every navigation. See src/lib/downloadGate.ts.
        context.add_init_script(
            "try { localStorage.setItem('ab_download_acked', '1'); } catch (e) {}"
        )
        page = context.new_page()

        # Collect console events from page + game iframe.
        events: list[tuple[str, str, str]] = []
        page.on("console", lambda m: events.append(("page", m.type, m.text)))
        page.on("pageerror", lambda e: events.append(("page", "error", str(e))))

        print(f"[smoke] {URL}")
        try:
            page.goto(URL, wait_until="domcontentloaded", timeout=20_000)
        except Exception as e:
            print(f"[smoke] FAIL — page navigation failed: {e}")
            return 1

        # Wait for the iframe to mount. /play/ renders GodotEmbed which
        # injects an <iframe> after a brief loading screen.
        try:
            iframe_handle = page.wait_for_selector("iframe", timeout=10_000)
        except Exception:
            print("[smoke] FAIL — no <iframe> mounted on /play/")
            return 1

        iframe = iframe_handle.content_frame()
        if iframe is None:
            print("[smoke] FAIL — iframe.content_frame() returned None")
            return 1
        iframe.on("console", lambda m: events.append(("game", m.type, m.text)))
        iframe.on("pageerror", lambda e: events.append(("game", "error", str(e))))

        # Poll for the game to actually boot. window.gameState.scene is set
        # by the engine once the title scene loads.
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
                print(f"[smoke] game ready after {elapsed}s, scene={scene}")
                break
        else:
            print(f"[smoke] WARN — game did not report ready scene in {BOOT_TIMEOUT_S}s")
            # Continue to log scraping — silent boot failure is a real case.

        # Grab the captured Godot stdout/stderr from the dev-console
        # interceptor that index.html installs. Lines are plain strings.
        try:
            logs = iframe.evaluate("window._consoleLogs || []") or []
        except Exception:
            logs = []

        bad: list[tuple[str, str]] = []
        for line in logs:
            for pat in SUSPECT_PATTERNS:
                if pat in line:
                    bad.append((pat, line[:240]))
                    break

        # Same patterns can also surface as direct console.error events.
        for src, ev_type, text in events:
            for pat in SUSPECT_PATTERNS:
                if pat in text:
                    bad.append((pat, f"[{src}/{ev_type}] {text[:240]}"))
                    break

        browser.close()

        if bad:
            print(f"\n[smoke] FAIL — {len(bad)} suspect log line(s):")
            for pat, line in bad[:8]:
                print(f"  - {pat!r}:")
                print(f"      {line}")
            return 1

        if not scene:
            # No suspect lines but also no scene — game hung silently.
            print("\n[smoke] FAIL — engine never reported a scene; silent boot failure")
            return 1

        print(f"[smoke] OK — engine booted, no MD5/encryption errors")
        return 0


if __name__ == "__main__":
    sys.exit(main())
