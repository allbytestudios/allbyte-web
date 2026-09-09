"""game_driver.py — deterministic game-driving helpers for the device matrix.

Owner: Quinn (QA). Imported by allbyte-web tests/e2e/test_device_matrix.py:
    from game_driver import start_new_game, assert_controls

Drives Chronicles of Nesis via the game's TestBridge window.* hooks — NO keyboard
(so it can't confuse a real input failure with a Playwright keyboard quirk). Works
on chromium / firefox / webkit. Pages load /godot/public/index.html (game is the
top-level page, same-origin → page.evaluate reaches window.gameState directly).

Both functions return bool (True=pass) and never raise on timeout — the matrix
records pass/fail. Verified on prod /godot/public/ across all three engines.
"""
import json, time

# cond_00 Elias' House — first MOVABLE scene (New Game start state). Inlined so the
# driver is self-contained (the matrix runs against prod; no file fetch needed).
COND_00_ELIAS_HOUSE = r'''{"combatStatusEffects":{},"discoveredDungeonScenes":[],"gameName":"ChroniclesOfNesis","mapMemory":{},"options":{},"overworldLocations":[],"partyConditions":[],"partyData":{"activeParty":"Elias","battleCount":0,"currency":0,"dataID":1,"difficulty":2,"positionX":27,"positionY":85,"scene":"res://World/ScenesAndScripts/Laria/ChurchSquare/EliasHouse.tscn","stepCount":0,"systemTime":68},"partyItems":[],"partySkillMenuRelics":[],"partySkills":[],"partyStats":[{"agility":2,"attackRange":1,"constitution":5,"currentHealth":11,"currentMana":7,"dataID":1,"dexterity":3,"experience":0,"intelligence":3,"knowledge":4,"level":1,"luck":8,"name":"Elias","speed":3,"stamina":6,"statusEffect":"{}","strength":7,"unspentAP":0,"unspentJP":0,"unspentSP":0,"wisdom":5}],"saveSlotId":1.0,"timestamp":1782502504.324,"treasureConditions":[],"version":1.0}'''


def _gs(page):
    try:
        return page.evaluate("() => window.gameState || {}") or {}
    except Exception:
        return {}


def _wait(page, pred, timeout_s, poll=0.4):
    end = time.time() + timeout_s
    while time.time() < end:
        if pred(_gs(page)):
            return True
        time.sleep(poll)
    return False


def start_new_game(page, timeout_s: float = 30) -> bool:
    """Title -> New Game -> commit Save -> intro begins. Hook-driven, no keyboard.
    PASS = left Title AND the Laria zone pack loaded (gameplay actually started).
    """
    if not _wait(page, lambda s: s.get("ready") and s.get("scene") == "Title", timeout_s):
        return False
    page.evaluate("window._triggerNewGame = true")
    # The difficulty/Save screen used to sit between Title and the intro, and this
    # waited on optionsShown to catch it. Difficulty was pinned to Medium and the
    # screen removed, so New Game now goes straight to the WordsOnBlack monologue
    # — the wait could never be satisfied and every run failed here, even though
    # the game had in fact started (verified on prod 0.8.2642: _triggerNewGame is
    # consumed, scene becomes WordsOnBlack, the Laria pack loads).
    #
    # Tolerate BOTH shapes rather than swapping one hard assumption for another:
    # if the screen appears, commit it; if it does not, carry on. The success
    # condition below is the real test either way.
    if _wait(page, lambda s: s.get("optionsShown") is True, 3):
        page.evaluate("window._testOpenMenu = 'options_save'")
    return _wait(
        page,
        lambda s: s.get("scene") not in (None, "Title")
        and "Laria" in (s.get("packsLoaded") or []),
        timeout_s,
    )


def assert_controls_forward(page, timeout_s: float = 60, min_delta_px: float = 10.0) -> bool:
    """Reach a playable scene BY PLAYING, then prove real keys move the player.

    Title -> New Game -> click through the WordsOnBlack monologue -> EliasHouse ->
    hold a direction key. No save injection and no _test* mutation hooks, so this
    needs no debug token and exercises exactly what an anonymous player does.

    This replaces the injection-based assert_controls for the public build. That
    one existed because the monologue could not be advanced ("flag hooks can't
    fire its transition"), which forced a jump PAST it via _testImportSave — a
    cheat backdoor that is correctly token-gated on the anonymous build. The
    owner's 2026-09-09 change made the monologue click-progressable, so the
    obstacle is gone and the honest path is available again.

    Real keypresses, not a hook: a hook proves the movement CODE runs, whereas a
    key proves a player can actually move. The old driver avoided the keyboard to
    keep Playwright quirks out of the signal; that trade made sense when input
    was not otherwise reachable, and no longer does.
    """
    if not _wait(page, lambda s: s.get("ready") and s.get("scene") == "Title", timeout_s):
        return False
    page.evaluate("window._triggerNewGame = true")
    if not _wait(page, lambda s: s.get("scene") not in (None, "Title"), timeout_s):
        return False
    # Advance the monologue. Click count is unknown and may change with the
    # script, so click until the scene moves on rather than assuming a number.
    end = time.time() + timeout_s
    while time.time() < end and _gs(page).get("scene") == "WordsOnBlack":
        try:
            page.mouse.click(550, 400)
        except Exception:
            pass
        time.sleep(1.0)
    if _gs(page).get("scene") in (None, "Title", "WordsOnBlack"):
        return False
    # Input arms a beat after the scene loads; readyForInput is the game's own
    # signal for that, so wait on it rather than on a fixed sleep.
    if not _wait(page, lambda s: s.get("readyForInput") and not s.get("isLocked"), 30):
        return False
    try:
        page.click("canvas", position={"x": 400, "y": 300})
    except Exception:
        pass
    for key in ("KeyS", "KeyW", "KeyA", "KeyD"):
        s0 = _gs(page)
        x0, y0 = s0.get("playerX") or 0, s0.get("playerY") or 0
        try:
            page.keyboard.down(key)
            time.sleep(0.9)
            page.keyboard.up(key)
        except Exception:
            continue
        time.sleep(0.5)
        s1 = _gs(page)
        x1, y1 = s1.get("playerX") or 0, s1.get("playerY") or 0
        if ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 > min_delta_px:
            return True  # a wall may block one direction; any real move proves input
    return False


def assert_controls(page, timeout_s: float = 25, min_delta_px: float = 10.0) -> bool:
    """Load the first movable scene (EliasHouse) and prove input moves the player.
    Avoids the WordsOnBlack cutscene entirely (flag hooks can't fire its transition).
    PASS = player position changes by > min_delta_px after a held-direction step.
    """
    env = json.dumps({"slot": 1, "data": json.loads(COND_00_ELIAS_HOUSE)})
    page.evaluate("window._testImportSave = " + json.dumps(env))
    time.sleep(0.5)
    page.evaluate("window._testLoadGame = 1")
    if not _wait(
        page,
        lambda s: s.get("scene") == "EliasHouse" and not s.get("isLocked"),
        timeout_s,
    ):
        return False
    time.sleep(0.5)  # let the scene settle / camera snap
    # try each direction; any real movement proves controls work (walls may block one)
    for direction in ("up", "down", "left", "right"):
        s0 = _gs(page)
        p0x, p0y = s0.get("playerX") or 0, s0.get("playerY") or 0
        page.evaluate("window._testHoldDirection = '%s,600'" % direction)
        time.sleep(1.3)
        s1 = _gs(page)
        delta = abs((s1.get("playerX") or 0) - p0x) + abs((s1.get("playerY") or 0) - p0y)
        if delta > min_delta_px:
            return True
    return False


if __name__ == "__main__":
    # standalone smoke test: python game_driver.py [chromium|firefox|webkit]
    import sys
    from playwright.sync_api import sync_playwright
    engine = sys.argv[1] if len(sys.argv) > 1 else "chromium"
    URL = "https://allbyte.studio/godot/public/index.html"
    with sync_playwright() as p:
        if engine == "chromium":
            br = p.chromium.launch(headless=True, args=[
                "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        else:
            br = getattr(p, engine).launch(headless=True)
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        pg.goto(URL, timeout=60000, wait_until="domcontentloaded")
        _wait(pg, lambda s: s.get("ready"), 60)
        ng = start_new_game(pg)
        # fresh page for controls (independent of the newgame run)
        pg2 = br.new_page(viewport={"width": 1280, "height": 900})
        pg2.goto(URL, timeout=60000, wait_until="domcontentloaded")
        _wait(pg2, lambda s: s.get("ready"), 60)
        ctl = assert_controls(pg2)
        print("[%s] start_new_game=%s assert_controls=%s" % (engine, ng, ctl))
        br.close()
