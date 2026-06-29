"""Cross-OS/browser gameplay QA matrix.

STATUS: v1 scaffolding, handed to Quinn for the game-driving layer (see
APP_CLAUDE_QA_DEVICE_MATRIX_HANDOFF.md). The browser/OS emulation matrix + boot
checks are solid (web-platform, App Claude). The NEW-GAME and CONTROLS steps
here drive the game by *guessing* keystrokes at the canvas — brittle, and it
can't distinguish a real input failure from a Playwright-keyboard quirk (that's
why the Firefox "new game" result is ambiguous). The robust version drives New
Game + movement via the game's _testBridge / _testAutoplay hooks (Quinn's
domain). NOT a CI gate — a manual diagnostic until the TestBridge-driving lands.

For each OS×browser combo (drawn from the play-funnel device classes, weighted
toward the LOW-ENGAGEMENT ones), run the three things a player must be able to do
and report which stage each combo fails at:

  1. BOOT     — the public build loads and reaches the Title screen.
  2. NEW GAME — pressing accept ("L") starts a new game (Title -> a gameplay scene).
  3. CONTROLS — movement input actually moves the player (playerX/Y changes).

Caveat: Playwright engines are chromium / firefox / webkit (the engine Safari is
built on). We emulate each combo as (engine + OS user-agent + viewport + touch) —
the closest automated proxy, NOT the literally-branded browser on the real OS.
For Safari/iOS specifically, webkit is a faithful engine match.

Run:  python tests/e2e/test_device_matrix.py
      BASE_URL=https://allbyte.studio  (default)  ·  exit 0 if every combo boots.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "https://allbyte.studio")
# The PUBLIC (non-debug) build — what players actually run.
URL = f"{BASE}/godot/public/index.html"
ACCEPT_KEY = "L"          # Title "New Game" -> accept
BOOT_TIMEOUT_S = 50       # Playwright Firefox boots the WASM slowly; be patient
TRANSIENT = ("MainLoader", "WordsOnBlack", "Title", None, "")  # not movable / not "booted"
CRASH_SIGS = ("out of bounds memory access", "memory access out of bounds", "Aborted(")

UA = {
    "ios": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "ipad": "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "android_chrome": "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "android_ff": "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0",
    "mac_safari": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "mac_chrome": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "mac_ff": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
    "win_chrome": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "linux_chrome": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "linux_ff": "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
}

# (label, engine, ua, viewport, touch, engagement-note)
DEVICES = [
    ("iOS Safari",     "webkit",   UA["ios"],          (390, 844), True,  "#1 platform"),
    ("iPadOS Safari",  "webkit",   UA["ipad"],         (1024, 768), True, "owner device"),
    ("Android Chrome", "chromium", UA["android_chrome"], (412, 915), True, "healthy baseline (88% boot)"),
    ("Android Firefox","firefox",  UA["android_ff"],   (412, 915), True,  "small sample, 100%"),
    ("macOS Safari",   "webkit",   UA["mac_safari"],   (1280, 800), False, "LOW: 29% boot"),
    ("macOS Chrome",   "chromium", UA["mac_chrome"],   (1280, 800), False, "LOW: 23% boot, 0% past-title"),
    ("macOS Firefox",  "firefox",  UA["mac_ff"],       (1280, 800), False, "LOW: 23% boot, 0% past-title"),
    ("Windows Chrome", "chromium", UA["win_chrome"],   (1280, 800), False, "LOW: 40% boot, 0% past-title"),
    ("Linux Chrome",   "chromium", UA["linux_chrome"], (1280, 800), False, "LOW: 23% boot"),
    ("Linux Firefox",  "firefox",  UA["linux_ff"],     (1280, 800), False, "LOW: 0% boot (bot-heavy)"),
]


def run_device(p, label, engine, ua, viewport, touch, note):
    res = {"label": label, "note": note, "boot": "—", "newgame": "—", "controls": "—",
           "boot_s": None, "scene": None, "detail": ""}
    try:
        browser = getattr(p, engine).launch()
    except Exception as e:
        res["boot"] = f"launch-fail"
        res["detail"] = str(e)[:80]
        return res
    # is_mobile is chromium-only in Playwright; has_touch unsupported on firefox.
    kw = {"viewport": {"width": viewport[0], "height": viewport[1]}, "user_agent": ua}
    if engine == "chromium":
        kw["is_mobile"] = touch
    if engine in ("chromium", "webkit"):
        kw["has_touch"] = touch
    ctx = browser.new_context(**kw)
    page = ctx.new_page()
    crash = {"hit": None}

    def on_console(m):
        t = m.text
        if crash["hit"] is None and any(s in t for s in CRASH_SIGS):
            crash["hit"] = t[:90]
    page.on("console", on_console)
    page.on("pageerror", lambda e: on_console(type("M", (), {"text": str(e)})()))

    try:
        page.goto(f"{URL}?cb={engine}{viewport[0]}", wait_until="domcontentloaded", timeout=20000)
    except Exception as e:
        res["boot"] = "FAIL"
        res["detail"] = f"nav: {str(e)[:60]}"
        browser.close()
        return res

    # 1) BOOT — wait for "Title" specifically (MainLoader is a transient boot
    # shim that swaps to Title, so breaking on the first non-null scene samples
    # too early).
    t0 = time.time()
    scene = None
    while time.time() - t0 < BOOT_TIMEOUT_S:
        page.wait_for_timeout(1000)
        if crash["hit"]:
            break
        try:
            scene = page.evaluate("window.gameState && window.gameState.scene || null")
        except Exception:
            scene = None
        if scene == "Title":
            break
    res["boot_s"] = round(time.time() - t0, 1)
    res["scene"] = scene
    if crash["hit"]:
        res["boot"] = "CRASH"
        res["detail"] = crash["hit"]
        browser.close()
        return res
    if scene != "Title":
        res["boot"] = "FAIL"
        res["detail"] = f"never reached Title (scene={scene})"
        browser.close()
        return res
    res["boot"] = "PASS"

    # 2) NEW GAME — wait until the Title actually accepts input, then press
    # accept (some engines, esp. Firefox, lag readyForInput well past boot).
    for _ in range(15):
        try:
            if page.evaluate("!!(window.gameState && window.gameState.readyForInput)"):
                break
        except Exception:
            pass
        page.wait_for_timeout(1000)
    past = None
    for _ in range(5):
        for k in (ACCEPT_KEY, "Enter"):
            try:
                page.keyboard.press(k)
            except Exception:
                pass
        page.wait_for_timeout(2500)
        try:
            past = page.evaluate("window.gameState && window.gameState.scene || null")
        except Exception:
            past = None
        if past and past != "Title":
            break
    if not past or past == "Title":
        res["newgame"] = "FAIL"
        res["detail"] = "accept didn't leave Title"
        browser.close()
        return res
    res["newgame"] = "PASS"
    res["scene"] = past

    # 3) CONTROLS — the intro (WordsOnBlack) is a non-movable cutscene that
    # auto-advances; wait for a movable gameplay scene before testing movement.
    for _ in range(12):
        try:
            sc = page.evaluate("window.gameState && window.gameState.scene || null")
        except Exception:
            sc = None
        if sc and sc not in TRANSIENT:
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(1500)
    try:
        before = page.evaluate("({x:window.gameState.playerX,y:window.gameState.playerY,s:window.gameState.scene})")
    except Exception:
        before = None
    for k in ("w", "d", "s", "a"):
        try:
            page.keyboard.down(k)
            page.wait_for_timeout(450)
            page.keyboard.up(k)
            page.wait_for_timeout(150)
        except Exception:
            pass
    try:
        after = page.evaluate("({x:window.gameState.playerX,y:window.gameState.playerY,s:window.gameState.scene})")
    except Exception:
        after = None
    moved = bool(before and after and (before["x"] != after["x"] or before["y"] != after["y"]))
    # A scene change also counts as input being processed (e.g. walked through a door).
    scene_changed = bool(before and after and before.get("s") != after.get("s"))
    res["controls"] = "PASS" if (moved or scene_changed) else "FAIL"
    if not (moved or scene_changed):
        res["detail"] = f"no movement in {after.get('s') if after else '?'}"
    res["scene"] = after.get("s") if after else res["scene"]
    browser.close()
    return res


def main():
    rows = []
    with sync_playwright() as p:
        for d in DEVICES:
            print(f"[matrix] {d[0]} ({d[1]}) …", flush=True)
            rows.append(run_device(p, *d))

    print("\n" + "=" * 92)
    print(f"DEVICE QA MATRIX  ·  {URL}")
    print("=" * 92)
    print(f"{'combo':<17}{'boot':<8}{'newgame':<10}{'controls':<10}{'boot_s':<8}{'scene':<14}note")
    print("-" * 92)
    for r in rows:
        print(f"{r['label']:<17}{r['boot']:<8}{r['newgame']:<10}{r['controls']:<10}"
              f"{str(r['boot_s'] or ''):<8}{str(r['scene'] or '')[:13]:<14}{r['note']}")
        if r["detail"]:
            print(f"{'':<17}↳ {r['detail']}")
    booted = sum(1 for r in rows if r["boot"] == "PASS")
    fully = sum(1 for r in rows if r["boot"] == "PASS" and r["newgame"] == "PASS" and r["controls"] == "PASS")
    print("-" * 92)
    print(f"booted: {booted}/{len(rows)}   ·   full pass (boot+newgame+controls): {fully}/{len(rows)}")
    return 0 if booted == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
