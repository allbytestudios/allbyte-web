"""
Smoke test for /play/ — catches the class of production breakage that hit on
2026-06-24 (the public-build reload loop): the page loads but the game never
boots to a scene, or the game iframe reload-loops forever.

Intended to run against PRODUCTION (where it actually guards real players):

    BASE_URL=https://allbyte.studio pytest tests/e2e/test_play_smoke.py

Against the local dev server it only passes if a working Godot build is being
served from CHRONICLES_DIR. The game is large (~100 MB + WASM compile), so the
boot timeout is generous; this is a slow test by nature.
"""
import time

# The game downloads ~100 MB and compiles WASM before the title scene reports,
# so give it room. Headless on a slow connection can take 30-60s.
BOOT_TIMEOUT_S = 90
POLL_S = 2
# Initial iframe load is 1 navigation; allow a little slack. More than this is
# the signature of the reload loop (the 2026-06-24 bug navigated continuously).
MAX_GODOT_NAVS = 2


def _godot_frame(page):
    for f in page.frames:
        if "/godot/" in (f.url or ""):
            return f
    return None


def test_play_boots_without_loop(page, base_url):
    """/play/ loads, the game boots to a scene, and the iframe does not loop."""
    nav_count = {"n": 0}

    def on_framenav(frame):
        if "/godot/" in (frame.url or ""):
            nav_count["n"] += 1

    page.on("framenavigated", on_framenav)

    page.goto(f"{base_url}/play/", wait_until="domcontentloaded", timeout=45000)

    scene = None
    deadline = time.time() + BOOT_TIMEOUT_S
    while time.time() < deadline:
        # Hard, fast failure if the wrapper reported an iframe load error
        # (GodotEmbed renders "Game failed to load." on iframe onerror).
        body = page.inner_text("body")
        assert "Game failed to load" not in body, "wrapper reported iframe load failure"

        f = _godot_frame(page)
        if f:
            try:
                # Same-origin (/play and /godot share the host), so we can read
                # the engine's reported scene straight off the iframe window.
                scene = f.evaluate(
                    "() => (window.gameState && window.gameState.scene) || null"
                )
            except Exception:
                scene = None
            if scene:
                break
        time.sleep(POLL_S)

    assert scene, (
        f"game did not boot to a scene within {BOOT_TIMEOUT_S}s "
        f"(last scene={scene!r}) — boot is broken"
    )
    assert nav_count["n"] <= MAX_GODOT_NAVS, (
        f"game frame navigated {nav_count['n']} times — reload loop suspected "
        f"(expected <= {MAX_GODOT_NAVS}). This is the 2026-06-24 /play bug class."
    )
