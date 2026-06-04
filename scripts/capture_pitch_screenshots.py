"""One-off screenshot pitch capture, run manually before Arc's
Autoplay protocol lands.

Boots /play/ on prod, lets Godot reach the Title scene, then drives a
basic synthetic-keyboard sequence (Enter to advance through Title menu,
arrow keys for movement, Escape for menus) to capture screenshots at
each meaningful state. Files land in public/captures/screenshots/
matching the schema in src/data/screenshots.json.

Not the long-term harness — that's the autoplay-capture pipeline
pending Arc's protocol. This is just a "give Drew something real to
react to before then" utility.

Run:
  python scripts/capture_pitch_screenshots.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "captures" / "screenshots"
TARGET_URL = "https://allbyte.studio/play/"
BOOT_TIMEOUT_S = 60

# Shots to capture as (id, description, action-before-shot)
# Actions are dispatched as synthetic KeyboardEvents directly at the
# Godot canvas via iframe.evaluate — same pattern VirtualGamepad uses,
# which is the proven path that gets keystrokes into Godot's web runtime.
SHOTS = [
    ("title_screen", "Title screen — initial boot", None),
    # Move highlight up to "New Game" (default is Continue)
    ("title_new_game_focused", "Title — New Game highlighted", "press:ArrowUp"),
    # Press Enter to start
    ("post_new_game_1", "After pressing Enter on New Game (intro / confirm)", "press:Enter"),
    ("post_new_game_2", "Continue intro / confirm flow", "press:Enter"),
    ("post_new_game_3", "Continue intro / confirm flow", "press:Enter"),
    ("post_new_game_4", "Continue intro / confirm flow", "press:Space"),
    ("post_new_game_5", "Continue intro / confirm flow", "press:Enter"),
    # Try to move once we're in-game
    ("walking_down", "Walking down briefly", "hold:ArrowDown:1500"),
    ("walking_right", "Walking right briefly", "hold:ArrowRight:1500"),
    ("walking_up", "Walking up briefly", "hold:ArrowUp:1500"),
    # Try opening menus
    ("after_escape", "Pause / menu attempt via Escape", "press:Escape"),
    ("after_inventory", "Inventory / items attempt via E", "press:KeyE"),
]


def dispatch_key(iframe, key: str, code: str | None = None, hold_ms: int = 100) -> None:
    """Dispatch synthetic KeyboardEvent at the Godot canvas inside the iframe.

    Matches the pattern VirtualGamepad uses on the production site —
    Godot's Emscripten runtime registers document-level listeners, so
    dispatching at the canvas with bubbles:true propagates correctly.
    Playwright's page.keyboard.press targets the parent page focus
    which doesn't reach the iframe.
    """
    code = code or key  # e.g., key=Enter code=Enter
    iframe.evaluate(
        """([k, c]) => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return false;
            const downEv = new KeyboardEvent('keydown', {
                key: k, code: c, bubbles: true, cancelable: true,
            });
            canvas.dispatchEvent(downEv);
            return true;
        }""",
        [key, code],
    )
    # Hold for hold_ms then release
    # (Playwright's wait_for_timeout is on the page, not the frame)
    import time as _time
    _time.sleep(hold_ms / 1000)
    iframe.evaluate(
        """([k, c]) => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return false;
            const upEv = new KeyboardEvent('keyup', {
                key: k, code: c, bubbles: true, cancelable: true,
            });
            canvas.dispatchEvent(upEv);
            return true;
        }""",
        [key, code],
    )


# Map our action key names to (key, code) tuples
KEY_MAP = {
    "Enter": ("Enter", "Enter"),
    "Escape": ("Escape", "Escape"),
    "Space": (" ", "Space"),
    "ArrowUp": ("ArrowUp", "ArrowUp"),
    "ArrowDown": ("ArrowDown", "ArrowDown"),
    "ArrowLeft": ("ArrowLeft", "ArrowLeft"),
    "ArrowRight": ("ArrowRight", "ArrowRight"),
    "KeyE": ("e", "KeyE"),
}


def boot(page, iframe) -> str:
    """Wait for Godot to reach a scene; return scene name."""
    elapsed = 0
    while elapsed < BOOT_TIMEOUT_S:
        page.wait_for_timeout(1000)
        elapsed += 1
        try:
            scene = iframe.evaluate("window.gameState?.scene || null")
        except Exception:
            scene = None
        if scene:
            return scene
    raise TimeoutError(f"Godot didn't reach a scene in {BOOT_TIMEOUT_S}s")


def run_action(page, iframe, iframe_elem, action: str | None) -> None:
    if action is None:
        return
    # Click into the iframe once on first action to capture user activation
    box = iframe_elem.bounding_box()
    if box:
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(150)

    if action.startswith("press:"):
        key = action.split(":", 1)[1]
        mapped_key, mapped_code = KEY_MAP.get(key, (key, key))
        dispatch_key(iframe, mapped_key, mapped_code, hold_ms=120)
    elif action.startswith("hold:"):
        _, key, duration_ms = action.split(":", 2)
        mapped_key, mapped_code = KEY_MAP.get(key, (key, key))
        dispatch_key(iframe, mapped_key, mapped_code, hold_ms=int(duration_ms))
    elif action == "wait":
        page.wait_for_timeout(1500)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Output: {OUT_DIR}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Bigger viewport to capture more of the canvas
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()

        print(f"Loading {TARGET_URL}")
        page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=30_000)

        try:
            iframe_elem = page.wait_for_selector("iframe", timeout=15_000)
        except Exception:
            print("ERROR: no iframe mounted")
            return 2

        iframe = iframe_elem.content_frame()
        if iframe is None:
            print("ERROR: iframe.content_frame() None")
            return 2

        print("Waiting for Godot boot…", end=" ", flush=True)
        try:
            scene = boot(page, iframe)
            print(f"OK (scene={scene})")
        except TimeoutError as e:
            print(f"FAIL: {e}")
            return 2

        for shot_id, desc, action in SHOTS:
            print(f"  Capturing {shot_id}…", end=" ", flush=True)
            run_action(page, iframe, iframe_elem, action)
            page.wait_for_timeout(1500)  # settle
            try:
                cur_scene = iframe.evaluate("window.gameState?.scene || 'unknown'")
            except Exception:
                cur_scene = "unknown"
            out_path = OUT_DIR / f"{shot_id}.png"
            # Screenshot just the iframe area to crop out the page chrome
            box = iframe_elem.bounding_box()
            if box:
                page.screenshot(
                    path=str(out_path),
                    clip={
                        "x": box["x"],
                        "y": box["y"],
                        "width": box["width"],
                        "height": box["height"],
                    },
                )
            else:
                page.screenshot(path=str(out_path), full_page=False)
            print(f"OK  (scene={cur_scene})")

        browser.close()
    print(f"\nWrote {len(SHOTS)} screenshots to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
