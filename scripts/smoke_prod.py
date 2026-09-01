"""
Post-deploy smoke test for the game on production.

What it catches that the existing smoke (`gameState.version`) does NOT:
the engine actually booting against the PCK. The 2026-06-01 black screen
slipped through because `current_version.txt` loads over the network
independent of the PCK — so the version stamp was correct while every
encrypted resource in the PCK was failing MD5. This script waits for the
Godot engine to actually boot, then scrapes `window._consoleLogs` (the
ARC-DEV-CONSOLE interceptor in index.html) for the canonical Godot
failure signatures.

Modes:
  (no args)                   Full live smoke: sw.js version match + /play/
                              embed boot + public-build boot. This is the
                              legacy behavior, run by push-assets and live
                              promotes after CloudFront invalidation.
  --channel <id>              Boot the named channel (from gameVersions.ts)
                              top-level on a cold context and assert it
                              reaches a scene. For a GATED channel (beta),
                              also asserts anonymous access is refused, and
                              boots through the signed-cookie flow (needs
                              SMOKE_JWT).
  --channel <id> --boot-only  Just the boot check — the dev-lane light smoke
                              push-channel runs after develop/beta-debug
                              deploys.
  --channel <id> --locked-only  Only assert the channel is NOT anonymously
                              reachable. Used by CI, which holds no secrets.
  --url <origin>              Override the site origin
                              (default https://allbyte.studio).

Env:
  SMOKE_URL             legacy full-URL override for the /play/ page
                        (no-args mode; default https://allbyte.studio/play/)
  SMOKE_JWT             a valid Initiate+ JWT, used to mint beta cookies
  BETA_COOKIE_ENDPOINT  cookie-issuing endpoint override
                        (default https://api.allbyte.studio/game/beta-cookies)
  SKIP_SMOKE=1          honored by the callers, not here

Exit codes:
  0  no errors detected
  1  one or more suspect log lines found, the game never became ready, or a
     gated channel was anonymously reachable
"""

from __future__ import annotations

import argparse
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

# Root containers (CodeBuild) can't run Chromium's sandbox — the exporter image
# sets SMOKE_CHROMIUM_NO_SANDBOX=1 so the in-build boot gate can launch headless.
# Empty (the default) everywhere else, so local/CI-runner behavior is unchanged.
CHROMIUM_LAUNCH_ARGS = ["--no-sandbox"] if os.environ.get("SMOKE_CHROMIUM_NO_SANDBOX") else []
# Marks this smoke run as our own CI in the CloudFront logs so the traffic
# aggregator drops it instead of counting it as a play. Appended to the real UA,
# never substituted. Same token as tests/cross-browser-qa/run.py.
QA_UA_TAG = "AllByteQA/1"


def _qa_context(browser, **kw):
    """new_context() with the CI marker appended to the User-Agent."""
    probe = browser.new_context()
    try:
        base = probe.new_page().evaluate("navigator.userAgent")
    finally:
        try:
            probe.close()
        except Exception:
            pass
    kw.setdefault("user_agent", f"{base} {QA_UA_TAG}")
    return browser.new_context(**kw)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION_FILE = os.path.join(REPO, "src", "data", "game-version.json")
GAME_VERSIONS_TS = os.path.join(REPO, "src", "lib", "gameVersions.ts")

# Channels whose base build sits behind the CloudFront signed-cookie gate.
# beta-debug + develop deliberately stay open (Legend/debug-only, low stakes —
# see docs/security-review-game-pipeline.md for the revisit trigger).
GATED_CHANNELS = {"beta"}


def channel_paths() -> dict:
    """Channel id -> iframe path, parsed from gameVersions.ts — the same
    single-source-of-truth regex push-channel.js uses, so the smoke and the
    deployer can never disagree about where a channel lives."""
    with open(GAME_VERSIONS_TS, encoding="utf-8") as f:
        src = f.read()
    return {
        m.group(1): m.group(2)
        for m in re.finditer(r'\{\s*id:\s*"([^"]+)"[^}]*?path:\s*"([^"]+)"', src)
    }


def game_version():
    """The COMMITTED game-version.json version — what CI bakes into the deployed
    webapp (the download gate keys on it) and injects into sw.js. Prefer the
    committed value over the working tree, which sync-assets.js re-stamps on
    local builds. Returns None if unreadable."""
    try:
        import subprocess
        return json.loads(subprocess.check_output(
            ["git", "show", "HEAD:src/data/game-version.json"],
            cwd=os.path.dirname(VERSION_FILE), text=True, stderr=subprocess.DEVNULL,
        ))["version"]
    except Exception:
        pass
    try:
        return json.load(open(VERSION_FILE, encoding="utf-8"))["version"]
    except Exception:
        return None


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
    # Compare against the COMMITTED game-version.json — that's what CI injects
    # into the deployed sw.js. The working-tree copy drifts on local builds.
    expected = game_version()
    if not expected:
        print("[smoke] WARN — couldn't read game-version.json; skipping sw.js version check")
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
    print("[smoke]   Returning users will serve a stale-keyed SW cache against new assets -> hang.")
    print("[smoke]   Fix: commit + deploy game-version.json so sw.js is stamped with the current version.")
    return 1

# Godot stderr lines that indicate a deploy-breaking failure.
SUSPECT_PATTERNS = [
    "MD5 sum of the decrypted file does not match",
    "Can't open encrypted pack-referenced file",
    "Cannot get class",  # missing pack template
    "ERROR: open_and_parse",  # encrypted file open failure
]


def check_channel_boot(url: str, label: str = "channel", cookies: list | None = None) -> int:
    """Boot a build directly (top-level, not iframed) on a cold context and
    assert it reaches a scene with no suspect log lines. Proves the deployed
    bytes boot; an iframe/cache hang is a separate, SW-version concern covered
    by check_sw_version(). `cookies` (playwright cookie dicts) lets a gated
    channel boot through its signed-cookie grant."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = _qa_context(browser, viewport={"width": 1280, "height": 800})
        if cookies:
            context.add_cookies(cookies)
        page = context.new_page()
        print(f"[smoke] {label}: {url}")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=20_000)
        except Exception as e:
            print(f"[smoke] FAIL — {label} navigation failed: {e}")
            browser.close()
            return 1
        # Fail fast if this isn't a Godot export at all — CloudFront's custom
        # error rewrite serves the site fallback HTML with a 200 for missing
        # paths, which would otherwise burn the whole boot timeout.
        try:
            html = page.content()
        except Exception:
            html = ""
        if not any(m in html for m in GODOT_MARKERS):
            print(f"[smoke] FAIL — {label} served the site fallback page, not a Godot build (channel not deployed?)")
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
            print(f"[smoke] FAIL — {label} has {len(bad)} suspect line(s): {bad[0][:160]}")
            return 1
        if not scene:
            print(f"[smoke] FAIL — {label} never reported a scene (sat on loading)")
            return 1
        print(f"[smoke] {label} booted, scene={scene}")
        return 0


def check_public_build() -> int:
    """Boot the PUBLIC build (/godot/public/) directly and assert it reaches a
    scene. This build is the anonymous homepage default (defaultVersion(null) ==
    "alpha" → /godot/public/index.html), yet check_boot() only exercises /play
    (the debug build). The public export has a history of shipping broken
    (2026-06-24 loop), so smoke it independently."""
    origin = "{0.scheme}://{0.netloc}".format(urlparse(URL))
    return check_channel_boot(f"{origin}/godot/public/index.html", label="public build")


# Markers that identify a real Godot web-export index.html (vs the site's
# Astro-generated fallback page). CloudFront's custom-error rewrite serves the
# site fallback with HTTP 200 for missing/denied paths (X-Cache: "Error from
# cloudfront"), so a status code alone can NEVER prove the gate — only the
# absence of actual game content can.
GODOT_MARKERS = ("GODOT_CONFIG", "pck-key-shim", 'id="canvas"')


def check_channel_locked(url: str) -> int:
    """Assert a gated channel's CONTENT is not anonymously retrievable.

    401/403 = correctly locked. 200 needs a body sniff: CloudFront's custom
    error responses rewrite denied/missing paths to the site's fallback HTML
    with a 200, which is fine (no game bytes leaked) — but a 200 whose body is
    a real Godot export index.html means the gate is open to the world (the
    alarm case: the CloudFront behavior lost its TrustedKeyGroups, or the path
    pattern regressed)."""
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        status, body = resp.status, resp.read(65536).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, body = e.code, ""
    except Exception as e:
        print(f"[smoke] WARN — lock check request failed outright ({e}); treating as locked")
        return 0
    if status in (401, 403):
        print(f"[smoke] gated channel correctly locked (HTTP {status})")
        return 0
    if status == 200 and any(m in body for m in GODOT_MARKERS):
        print(f"[smoke] FAIL — {url} served REAL GAME CONTENT anonymously (HTTP 200).")
        print("[smoke]   The signed-cookie gate is not enforcing. Check the CloudFront")
        print("[smoke]   behavior for this path still has TrustedKeyGroups enabled.")
        return 1
    if status == 200:
        print("[smoke] gated channel returned the site fallback page (error rewrite), not game content — locked")
        return 0
    print(f"[smoke] gated channel returned HTTP {status} without game content — treating as locked")
    return 0


def get_beta_cookies(origin: str) -> list | None:
    """Exchange SMOKE_JWT for CloudFront signed cookies via the cookie endpoint.
    Returns playwright cookie dicts, or None (with a message) on failure."""
    jwt = os.environ.get("SMOKE_JWT")
    if not jwt:
        print("[smoke] SMOKE_JWT not set — cannot run the entitled beta boot.")
        print("[smoke]   Set SMOKE_JWT to a valid Initiate+ token, or use --locked-only.")
        return None
    endpoint = os.environ.get(
        "BETA_COOKIE_ENDPOINT", "https://api.allbyte.studio/game/beta-cookies"
    )
    req = urllib.request.Request(endpoint, headers={"Authorization": f"Bearer {jwt}"})
    try:
        resp = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        print(f"[smoke] cookie endpoint refused (HTTP {e.code}) — is the JWT Initiate+ and unexpired?")
        return None
    except Exception as e:
        print(f"[smoke] cookie endpoint unreachable: {e}")
        return None
    raw = resp.headers.get_all("Set-Cookie") or []
    host = urlparse(origin).netloc.split(":")[0]
    cookies = []
    for line in raw:
        first = line.split(";", 1)[0]
        if "=" not in first:
            continue
        name, value = first.split("=", 1)
        m = re.search(r"[Pp]ath=([^;]+)", line)
        cookies.append({
            "name": name.strip(),
            "value": value.strip(),
            "domain": host,
            "path": (m.group(1).strip() if m else "/godot/beta"),
            "secure": True,
        })
    if not cookies:
        print("[smoke] cookie endpoint returned no Set-Cookie headers")
        return None
    print(f"[smoke] obtained {len(cookies)} signed cookie(s) from {endpoint}")
    return cookies


def check_boot() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = _qa_context(browser, viewport={"width": 1280, "height": 800})
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

        # /play gates the first load behind a consent notice that withholds the
        # game iframe until the user consents. Click through it if present —
        # version-independent (works for both the "fresh" and "update" variants),
        # unlike a version-keyed localStorage pre-ack which would couple the smoke
        # to whatever game version the DEPLOYED webapp bakes in (and false-fail
        # mid-deploy, before the webapp redeploys). See src/lib/downloadGate.ts.
        try:
            page.click(".dl-go", timeout=6_000)
            print("[smoke] clicked through the download gate")
        except Exception:
            pass  # no gate (already consented on this context) — fine

        # Resolve the game frame by URL, never by holding an ElementHandle.
        #
        # /play/ can REMOUNT the iframe after first paint — a tier-gated
        # ?v=/?channel= link swaps src once /auth/me lands, and the stale-cache
        # self-heal reloads outright. A handle taken before that dies with the
        # old element, and content_frame() then raises "Element is not attached
        # to the DOM" — which crashed the smoke rather than failing it, so the
        # boot check silently stopped running while still looking like coverage.
        #
        # page.frames is re-read on every poll, so a remount just resolves to the
        # new frame on the next tick.
        def game_frame():
            for f in page.frames:
                if f is not page.main_frame and "/godot/" in (f.url or ""):
                    return f
            return None

        iframe = None
        for _ in range(40):  # 20s
            iframe = game_frame()
            if iframe is not None:
                break
            page.wait_for_timeout(500)
        if iframe is None:
            print("[smoke] FAIL — no /godot/ frame mounted on /play/")
            return 1

        # Console/error listeners live on the PAGE, which reports messages from
        # every frame — so they survive a remount that would orphan frame-level
        # handlers. Frame is tagged by url at read time instead.
        page.on("console", lambda m: events.append(("game", m.type, m.text))
                if "/godot/" in (m.location or {}).get("url", "") else None)

        # Poll for the game to actually boot. window.gameState.scene is set
        # by the engine once the title scene loads.
        scene = None
        elapsed = 0
        while elapsed < BOOT_TIMEOUT_S:
            page.wait_for_timeout(READY_POLL_S * 1000)
            elapsed += READY_POLL_S
            try:
                # Re-resolve each poll: a remount mid-boot would otherwise leave
                # us evaluating against a dead frame forever.
                fr = game_frame() or iframe
                scene = fr.evaluate("window.gameState?.scene || null")
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
            logs = (game_frame() or iframe).evaluate("window._consoleLogs || []") or []
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

        # The stale-cache self-heal must NEVER fire on this cold context — a
        # fresh profile can't hold a stale SW cache, so any [recover] line here
        # means every first-time visitor is being forced through a cache-clear
        # double load (2026-07-16: strict version compare false-positived on
        # cloud builds' "<version>-<commit>" stamp). The game still boots after
        # the reload, so no other check catches this.
        recover = [text for _src, _t, text in events if "[recover]" in text]

        browser.close()

        if recover:
            print(f"\n[smoke] FAIL — self-heal fired on a COLD context (fresh visitors double-load):")
            print(f"      {recover[0][:240]}")
            return 1

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


def run_channel_smoke(channel: str, origin: str, boot_only: bool, locked_only: bool) -> int:
    paths = channel_paths()
    if channel not in paths:
        print(f"[smoke] unknown channel '{channel}' — known: {', '.join(paths)}")
        return 1
    url = origin.rstrip("/") + paths[channel]
    gated = channel in GATED_CHANNELS

    if locked_only:
        if not gated:
            print(f"[smoke] --locked-only makes no sense for open channel '{channel}'")
            return 1
        return check_channel_locked(url)

    codes = []
    if gated and not boot_only:
        codes.append(check_channel_locked(url))
    if gated:
        cookies = get_beta_cookies(origin)
        if cookies is None:
            return 1
        codes.append(check_channel_boot(url, label=channel, cookies=cookies))
    else:
        codes.append(check_channel_boot(url, label=channel))
    return 1 if any(codes) else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Post-deploy smoke for the game")
    ap.add_argument("--channel", help="channel id from gameVersions.ts to smoke directly")
    ap.add_argument("--url", help="site origin override (default https://allbyte.studio)")
    ap.add_argument("--boot-only", action="store_true",
                    help="only the boot check (dev-lane light smoke)")
    ap.add_argument("--locked-only", action="store_true",
                    help="only assert the gated channel refuses anonymous access")
    args = ap.parse_args()

    if args.channel:
        origin = args.url or "{0.scheme}://{0.netloc}".format(urlparse(URL))
        return run_channel_smoke(args.channel, origin, args.boot_only, args.locked_only)

    # Legacy no-args mode: the full live smoke. Run all checks for full
    # diagnostics; fail if any fails.
    sw_code = check_sw_version()
    boot_code = check_boot()
    public_code = check_public_build()
    return sw_code or boot_code or public_code


if __name__ == "__main__":
    sys.exit(main())
