"""Regression: the scenario launcher must boot the leveled Sluice Gate boss
scenario without a WASM crash or reload loop.

Repro of the 2026-07-08 report: jumping into
  /play/?channel=develop&scenario=sluicegate_boss_leveled&packs=Laria,Combat
first boot-looped (AutoReload read the CloudFront HTML fallback as a "version"),
then — once that was fixed — crashed with "memory access out of bounds" while
loading the scenario.

This drives the develop build's game page directly via the TestBridge window.*
hooks (same approach as game_driver.py — no keyboard, no iframe), replicating
GodotEmbed.svelte's runScenario(): mount packs -> wait until their scene classes
register -> import the save -> load it (the real DAL load).

Target: the DEPLOYED develop build by default. The `develop` channel and its packs
are NOT served by the local dev proxy (the local export has no develop/packs/ dir),
so `?channel=develop` only fully exists once deployed. Override with SCENARIO_BASE
(e.g. a local dev server that DOES serve the develop channel + packs).

Run:  python -m pytest tests/e2e/test_scenario_boss_boot.py -v
      SCENARIO_BASE=http://localhost:4321 python -m pytest tests/e2e/test_scenario_boss_boot.py -v
      python tests/e2e/test_scenario_boss_boot.py          # standalone, verbose
"""
import json
import os
import pathlib
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("SCENARIO_BASE", "https://allbyte.studio").rstrip("/")
CHANNEL = os.environ.get("SCENARIO_CHANNEL", "develop")
GAME_URL = f"{BASE}/godot/{CHANNEL}/index.html"

_FIXTURE = (
    pathlib.Path(__file__).resolve().parents[2]
    / "public" / "scenario-fixtures" / "sluicegate_boss_leveled.json"
)
PACKS = ["Laria", "Combat"]            # what the catalogue/URL mounts for this scenario
EXPECT_SCENE = "SluiceGate"            # gameState.scene basename once the save loads

# Emscripten / Godot-web hard-failure signatures. "memory access out of bounds" is
# the exact 2026-07-08 crash; the others catch the same class of trap.
CRASH_MARKERS = (
    "memory access out of bounds",
    "Aborted(",
    "RuntimeError: ",
    "index out of bounds",
    "Cannot enlarge memory",
    "table index is out of bounds",
)


def _gs(page):
    try:
        return page.evaluate("() => window.gameState || {}") or {}
    except Exception:
        return {}


def _wait(page, pred, timeout_s, poll=0.4):
    end = time.time() + timeout_s
    while time.time() < end:
        try:
            if pred(_gs(page)):
                return True
        except Exception:
            pass
        time.sleep(poll)
    return False


def _drive_scenario(page):
    """Returns (booted, crashes, last_scene, reached). `reached` is the furthest
    phase the flow got to before crashing/timing out — 'boot' | 'ready' | 'packs'
    | 'scene'. Never raises on timeout."""
    crashes = []
    reached = "boot"

    def _sniff(text):
        if text and any(k in text for k in CRASH_MARKERS):
            crashes.append(text)

    page.on("console", lambda m: _sniff(m.text))
    page.on("pageerror", lambda e: _sniff(str(e)))

    fixture = json.loads(_FIXTURE.read_text(encoding="utf-8"))

    page.goto(GAME_URL, timeout=60000, wait_until="domcontentloaded")

    # 1. engine up (no boot loop -> reaches ready)
    if not _wait(page, lambda s: s.get("ready"), 60):
        return False, crashes, _gs(page).get("scene"), reached
    reached = "ready"

    # 2. mount packs, WAIT until their scene classes register (else the load warps
    #    into a null scene). Mirrors runScenario()'s packsLoaded gate.
    page.evaluate("window._testLoadPacks = %s" % json.dumps(",".join(PACKS)))
    if not _wait(
        page,
        lambda s: all(pk in (s.get("packsLoaded") or []) for pk in PACKS),
        60,
    ):
        return False, crashes, _gs(page).get("scene"), reached
    reached = "packs"

    # 3. import the leveled save into slot 1, then load it (the real DAL "Continue")
    page.evaluate("window._testImportSave = " + json.dumps({"slot": 1, "data": fixture}))
    time.sleep(0.5)
    page.evaluate("window._testLoadGame = 1")

    booted = _wait(
        page,
        lambda s: s.get("scene") == EXPECT_SCENE and not s.get("isLocked"),
        45,
    )
    if booted:
        reached = "scene"
    return booted, crashes, _gs(page).get("scene"), reached


def test_sluicegate_boss_leveled_boots():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        try:
            booted, crashes, last_scene, reached = _drive_scenario(page)
        finally:
            browser.close()

    assert not crashes, (
        f"WASM crash after phase '{reached}' while loading the leveled Sluice Gate "
        f"scenario ({GAME_URL}): " + " | ".join(crashes[:3])
    )
    assert booted, (
        f"scenario never reached scene '{EXPECT_SCENE}' (got to phase '{reached}', "
        f"last scene={last_scene!r}) at {GAME_URL}"
    )


if __name__ == "__main__":
    with sync_playwright() as p:
        br = p.chromium.launch(headless=True)
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        try:
            booted, crashes, last_scene, reached = _drive_scenario(pg)
        finally:
            br.close()
        print(f"[scenario-boot] url={GAME_URL}")
        print(f"[scenario-boot] booted={booted} reached_phase={reached} last_scene={last_scene!r}")
        print(f"[scenario-boot] crashes={crashes[:3]}")
        raise SystemExit(0 if (booted and not crashes) else 1)
