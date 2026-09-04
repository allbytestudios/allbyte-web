"""Regression tests for the /play/ loading sequence.

THE INVARIANT (owner, 2026-09-03): from the moment the page paints until the
game is visible, SOMETHING must always be animating — the AllByte bits, or the
corner spinner, or the card scene. A still frame reads as a crash.

Why these tests record VIDEO instead of taking screenshots: booting the game
blocks the main thread with a single ~8.8-second long task while the WASM
compiles. Playwright's screenshot and evaluate both need the renderer, so they
queue behind that block and silently report post-block state — which is exactly
how a frozen loading screen passed "verification" repeatedly by hand. Video
capture is driven by the compositor, so it records what was actually PRESENTED.
That is the only measurement that can see this class of bug.

Run:  pytest tests/e2e/test_load_screen.py
(needs the dev server, or BASE_URL=https://allbyte.studio for prod)
"""

from __future__ import annotations

import glob
import hashlib
import os
import shutil
import subprocess
import tempfile

import pytest
from PIL import Image

BASE_URL = os.environ.get("BASE_URL", "http://localhost:4321")
VIEW_W, VIEW_H = 800, 520
RECORD_MS = 14_000
FPS = 25

# The spinner is inset by clamp(16px, 4.5vmin, 30px) and sized clamp(19px,
# 4.4vmin, 32px). At 800x520 that is ~23px inset, ~23px across — so a 34px box
# in the corner contains it with a little margin. Crop TIGHTLY: a large crop
# dilutes a 23px sprite's motion below any sensible difference threshold, which
# is what made an early version of this check report false stalls.
SPIN_CROP = (34, 34, VIEW_W - 52, VIEW_H - 52)  # w, h, x, y

# Longest run of identical presented frames we accept while loading. The
# spinner steps 6 frames at 8.5fps (~118ms/frame) and rotates continuously, so
# anything past ~300ms means it genuinely stopped rather than being between
# sprite frames.
MAX_STALL_MS = 400


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        pytest.skip("ffmpeg not on PATH — needed to inspect presented frames")
    return exe


def _record(browser, url: str) -> str:
    """Record the load and return the video path."""
    out = tempfile.mkdtemp(prefix="loadscreen-")
    ctx = browser.new_context(
        viewport={"width": VIEW_W, "height": VIEW_H},
        record_video_dir=out,
        record_video_size={"width": VIEW_W, "height": VIEW_H},
    )
    page = ctx.new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(RECORD_MS)
    ctx.close()  # flushes the video
    vids = glob.glob(os.path.join(out, "*.webm"))
    assert vids, "playwright produced no video"
    return vids[0]


def _frames(video: str, crop: tuple[int, int, int, int]) -> list[str]:
    """Hash each presented frame of a cropped region."""
    w, h, x, y = crop
    tmp = tempfile.mkdtemp(prefix="frames-")
    subprocess.run(
        [_ffmpeg(), "-loglevel", "error", "-i", video,
         "-vf", f"crop={w}:{h}:{x}:{y}", "-r", str(FPS),
         "-y", os.path.join(tmp, "f_%04d.png")],
        check=True,
    )
    out = []
    for f in sorted(glob.glob(os.path.join(tmp, "f_*.png"))):
        im = Image.open(f).convert("L")
        out.append(hashlib.md5(im.tobytes()).hexdigest())
    shutil.rmtree(tmp, ignore_errors=True)
    return out


def _first_painted(video: str) -> int:
    """Index of the first frame after the page paints.

    The recording starts before navigation, so it opens on a white viewport.
    Everything before that is not the loading screen and must not be judged.
    """
    tmp = tempfile.mkdtemp(prefix="paint-")
    subprocess.run(
        [_ffmpeg(), "-loglevel", "error", "-i", video, "-vf", "scale=40:26",
         "-r", str(FPS), "-y", os.path.join(tmp, "p_%04d.png")],
        check=True,
    )
    idx = 0
    for i, f in enumerate(sorted(glob.glob(os.path.join(tmp, "p_*.png")))):
        px = list(Image.open(f).convert("L").getdata())
        if sum(px) / len(px) < 200:  # no longer the blank pre-navigation white
            idx = i
            break
    shutil.rmtree(tmp, ignore_errors=True)
    return idx


def _longest_stall_ms(hashes: list[str], start: int) -> tuple[int, float]:
    """Longest run of identical frames after `start`, and where it began."""
    worst, worst_at, run = 1, start, 1
    for i in range(start + 1, len(hashes)):
        run = run + 1 if hashes[i] == hashes[i - 1] else 1
        if run > worst:
            worst, worst_at = run, (i - run + 1) / FPS
    return int(worst / FPS * 1000), worst_at


@pytest.fixture(scope="module")
def video(browser):
    return _record(browser, f"{BASE_URL}/play/")


def test_spinner_never_stalls(video):
    """The corner spinner must keep moving for the whole load.

    It used to be drawn on the worker canvas, which does not exist until the
    worker starts — so it was absent for the entire AllByte scene and appeared
    partway through. It is now DOM with composited CSS animations.
    """
    start = _first_painted(video)
    hashes = _frames(video, SPIN_CROP)
    assert len(hashes) > start + FPS, "recording too short to judge"

    # Allow the first half-second after paint: the animation has not started and
    # the reveal at the end legitimately removes the spinner.
    begin = start + FPS // 2
    tail = int(len(hashes) - FPS * 1.5)
    stall_ms, at = _longest_stall_ms(hashes[:tail], begin)

    distinct = len(set(hashes[begin:tail]))
    assert distinct > (tail - begin) * 0.5, (
        f"spinner barely changes: only {distinct} distinct frames across "
        f"{tail - begin} — it is not animating"
    )
    assert stall_ms <= MAX_STALL_MS, (
        f"spinner stalled {stall_ms}ms at ~{at:.2f}s (limit {MAX_STALL_MS}ms). "
        "Most likely something moved it back onto a JS timer or a non-composited "
        "property — see the notes in GodotEmbed.svelte's .load-spin."
    )


def test_something_is_always_animating(video):
    """The owner's invariant, over the whole frame rather than one region.

    Bits, spinner or cards — it does not matter which, but a long identical
    stretch means the loading screen looked crashed.
    """
    start = _first_painted(video)
    hashes = _frames(video, (VIEW_W, VIEW_H, 0, 0))
    begin = start + FPS // 2
    stall_ms, at = _longest_stall_ms(hashes, begin)
    assert stall_ms <= 1000, (
        f"the whole screen was identical for {stall_ms}ms at ~{at:.2f}s — "
        "nothing was animating, which reads as a crash"
    )


def test_studio_scene_then_cards(page):
    """The AllByte scene shows its bits, then hands off to the card scene."""
    page.goto(f"{BASE_URL}/play/", wait_until="domcontentloaded")

    # 16 glyphs = 8 positions x {0,1}; the CSS keyframes cross-fade each pair.
    page.wait_for_selector(".sm-bit", timeout=5_000)
    assert page.locator(".sm-bit").count() == 16, (
        "expected 8 bit positions with both glyphs — the studio scene is meant "
        "to be CSS-driven, with no text mutation"
    )
    assert page.locator(".load-spin").count() == 1, "spinner missing from the studio scene"

    # The mark must clear itself ON TIME. Assert it goes INVISIBLE, not that it
    # detaches: detaching is JS work that queues behind the ~8.8s boot block,
    # whereas the fade is a parse-time CSS animation that cannot be starved.
    # That distinction is the fix — the mark once overstayed ~9s precisely
    # because its removal depended on a timer.
    page.wait_for_timeout(2_600)  # studio ends at 2000ms + margin
    opacity = page.evaluate(
        "() => { const m = document.querySelector('.studio-static-mark');"
        " return m ? +getComputedStyle(m).opacity : 0; }"
    )
    assert opacity < 0.05, (
        f"AllByte mark still visible (opacity {opacity}) after the studio scene "
        "should have ended — its fade is CSS on a parse-time clock, so this "
        "means something re-coupled it to JS timing"
    )
    assert page.locator("canvas.worker-load").count() == 1, (
        "worker canvas gone — the card scene and the Elias/slime transition "
        "both live there"
    )
