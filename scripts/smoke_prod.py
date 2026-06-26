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

import json
import os
import re
import sys
import time
import urllib.request
from urllib.parse import urlparse

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[smoke] playwright not installed; `pip install playwright && playwright install chromium`")
    sys.exit(1)

URL = os.environ.get("SMOKE_URL", "https://allbyte.studio/play/")
BOOT_TIMEOUT_S = 45  # generous; first-load with cold cache is slow
READY_POLL_S = 1

VERSION_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "src", "data", "game-version.json",
)


def check_sw_version() -> int:
    """Assert the DEPLOYED sw.js BUILD_VERSION matches the game version.

    This is the check that would have caught the 2026-06-26 stale-cache hang:
    the SW keys its cache on BUILD_VERSION, so if the deployed sw.js lags the
    game assets (e.g. game-version.json bumps never committed, CI kept stamping
    the old version), returning users serve old WASM/PCK against the new
    index.html → MD5 mismatch / hang. Mechanism tests can't catch this — it's a
    deploy-version drift, only visible against the live sw.js. Retries to ride
    out CloudFront invalidation propagation.
    """
    try:
        expected = json.load(open(VERSION_FILE, encoding="utf-8"))["version"]
    except Exception as e:
        print(f"[smoke] WARN — couldn't read game-version.json ({e}); skipping sw.js version check")
        return 0
    origin = "{0.scheme}://{0.netloc}".format(urlparse(URL))
    pat = re.compile(r'BUILD_VERSION\s*=\s*"([^"]+)"')
    got = None
    for attempt in range(6):  # ~30s for invalidation to propagate
        try:
            req = urllib.request.Request(
                f"{origin}/sw.js?cb={attempt}", headers={"Cache-Control": "no-cache"}
            )
            sw = urllib.request.urlopen(req, timeout=10).read().decode("utf-8", "replace")
            m = pat.search(sw)
            got = m.group(1) if m else None
            if got == expected:
                print(f"[smoke] sw.js BUILD_VERSION == game version ({expected})")
                return 0
            print(f"[smoke] sw.js version {got!r} != game version {expected!r} (attempt {attempt + 1}/6)")
        except Exception as e:
            print(f"[smoke] sw.js fetch error (attempt {attempt + 1}/6): {e}")
        time.sleep(5)
    print(f"\n[smoke] FAIL — deployed sw.js BUILD_VERSION ({got!r}) never matched game version ({expected!r}).")
    print("[smoke]   Returning users will serve a stale-keyed SW cache against new assets → hang.")
    print("[smoke]   Fix: commit + deploy game-version.json so sw.js is stamped with the current version.")
    return 1

# Godot stderr lines that indicate a deploy-breaking failure.
SUSPECT_PATTERNS = [
    "MD5 sum of the decrypted file does not match",
    "Can't open encrypted pack-referenced file",
    "Cannot get class",  # missing pack template
    "ERROR: open_and_parse",  # encrypted file open failure
]


def check_public_build() -> int:
    """Boot the PUBLIC build (/godot/public/) directly and assert it reaches a
    scene. This build is the anonymous homepage default (defaultVersion(null) ==
    "alpha" → /godot/public/index.html), yet check_boot() only exercises /play
    (the debug build). The public export has a history of shipping broken
    (2026-06-24 loop), so smoke it independently. Loaded top-level (not iframed)
    on a cold context — proves the deployed bytes boot; an iframe/cache hang is
    a separate, SW-version concern covered by check_sw_version().
    """
    origin = "{0.scheme}://{0.netloc}".format(urlparse(URL))
    url = f"{origin}/godot/public/index.html"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
        print(f"[smoke] public build: {url}")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=20_000)
        except Exception as e:
            print(f"[smoke] FAIL — public build navigation failed: {e}")
            browser.close()
            return 1
        scene = None
        for _ in range(BOOT_TIMEOUT_S):
            page.wait_for_timeout(1000)
            try:
                scene = page.evaluate("window.gameState && window.gameState.scene || null")
            except Exception:
                scene = None
            if scene:
                break
        try:
            logs = page.evaluate("window._consoleLogs || []") or []
        except Exception:
            logs = []
        browser.close()
        bad = [ln for ln in logs if any(pat in ln for pat in SUSPECT_PATTERNS)]
        if bad:
            print(f"[smoke] FAIL — public build has {len(bad)} suspect line(s): {bad[0][:160]}")
            return 1
        if not scene:
            print("[smoke] FAIL — public build never reported a scene (sat on loading)")
            return 1
        print(f"[smoke] public build booted, scene={scene}")
        return 0


def check_boot() -> int:
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


def main() -> int:
    # Run all checks for full diagnostics; fail if any fails.
    sw_code = check_sw_version()
    boot_code = check_boot()
    public_code = check_public_build()
    return sw_code or boot_code or public_code


if __name__ == "__main__":
    sys.exit(main())
