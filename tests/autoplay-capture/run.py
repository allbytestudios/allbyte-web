"""Autoplay capture orchestrator — Phase 2 (contract-stable v1).

Drives Arc's AutoPlay surface (hooks in `WebBootstrap/Autoload/AutoPlay.gd`)
via parent-window vars that the game polls across the iframe boundary.

This v1 uses the existing `window._test*` hooks which work today. When Phase 3
lands the formal `allbyte:autoplay-capture-start/stop/status` postMessage
protocol, the `enable_autoplay()` and `wait_for_done()` calls swap over —
everything else (event collection, fixture loading, ffmpeg lifecycle via
boot.sh) stays identical.

Outputs:
- ${MP4_PATH}            — recorded video+audio (ffmpeg, written by boot.sh)
- ${TIMELINE_PATH}       — JSON: {events: [{t, kind, payload}], meta: {...}}

The timeline.json is what the downstream clip-extractor reads to know where
to cut, and what to caption.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright, Page, ConsoleMessage

# -- Config ------------------------------------------------------------------

DEFAULT_TARGET_URL = os.environ.get(
    "TARGET_URL",
    "http://host.docker.internal:4321/play/",
)
DEFAULT_FIXTURE = os.environ.get(
    "FIXTURE_PATH",
    "WebTests/fixtures/saves/frontier/cond_11_waterway1_entry.json",
)
DEFAULT_PERSONA = os.environ.get("PERSONA", "scout")
DEFAULT_DURATION_S = int(os.environ.get("DURATION_S", "60"))
DEFAULT_STARTUP_SKIP_S = int(os.environ.get("STARTUP_SKIP_S", "22"))

# Console log patterns we capture as events on the timeline. Arc confirmed
# these are stable Phase 2 grep sources; the formal allbyte:event-* emits
# (Phase 4) will run in parallel without retiring these print() lines.
EVENT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("combat", re.compile(r"^\[combat\]\s+(.*)$")),
    ("skill", re.compile(r"^\[skill\]\s+(.*)$")),
    ("autoplay", re.compile(r"^\[AutoPlay\]\s+(.*)$")),
    ("explore", re.compile(r"^\[explore.*?\]\s+(.*)$")),
    ("unit_died", re.compile(r"^\[CombatOverlay\]\s+unit_died:\s+(.*)$")),
]


# -- Capture session ---------------------------------------------------------


class CaptureSession:
    """One end-to-end autoplay capture run.

    Lifecycle:
        await session.boot()         # launch browser, navigate
        await session.load_fixture() # warp to repeatable starting state
        await session.run(duration)  # enable autoplay, collect events
        await session.finalize()     # write timeline.json, close browser
    """

    def __init__(self, target_url: str, fixture_path: str, persona: str) -> None:
        self.target_url = target_url
        self.fixture_path = fixture_path
        self.persona = persona
        self.t0: float = 0.0
        self.events: list[dict[str, Any]] = []
        self._page: Page | None = None

    async def boot(self, playwright) -> None:
        # headless=False because we're recording the screen via Xvfb x11grab
        # — Playwright's record_video_dir is video-only (Arc confirmed
        # empirically) so we need the real framebuffer.
        browser = await playwright.chromium.launch(
            headless=False,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                # COOP/COEP are set by CloudFront in prod and the Astro dev
                # middleware in dev. Chromium needs to enforce same-origin
                # isolation so the Godot iframe can use SharedArrayBuffer.
                "--enable-features=SharedArrayBuffer",
            ],
        )
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        self._page = await context.new_page()
        self._page.on("console", self._on_console)
        await self._page.goto(self.target_url, wait_until="networkidle")
        # Wait for the iframe to mount and the game bootstrapper to be ready.
        # Game posts `allbyte:ready` on init; saves.svelte.ts catches it and
        # flips saves.gameReady to true. We poll a parent-window mirror that
        # this harness installs.
        await self._page.evaluate(
            """
            window.__captureReady = false;
            window.addEventListener('message', (e) => {
                if (e?.data?.type === 'allbyte:ready') window.__captureReady = true;
            });
            """
        )
        await self._page.wait_for_function(
            "() => window.__captureReady === true", timeout=30_000
        )

    async def load_fixture(self) -> None:
        # Game-side TestBridge exposes _testImportSave + _testLoadGame on the
        # iframe window. We reach across via the iframe contentWindow.
        # The Astro page wraps Godot in an iframe at #godot-frame; the parent
        # page is same-origin with the iframe (both served from allbyte.studio
        # / localhost), so direct access works.
        assert self._page is not None
        await self._page.evaluate(
            """
            async (path) => {
                const frame = document.querySelector('iframe');
                if (!frame) throw new Error('no iframe found on /play/');
                // _testImportSave reads from server-side fixture path; the
                // Godot harness handles the fetch internally.
                frame.contentWindow._testImportSave = path;
                // Loop until the import setter clears (game consumed it).
                for (let i = 0; i < 50; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    if (!frame.contentWindow._testImportSave) break;
                }
                frame.contentWindow._testLoadGame = 'true';
            }
            """,
            self.fixture_path,
        )

    async def enable_autoplay(self) -> None:
        assert self._page is not None
        await self._page.evaluate(
            """
            (persona) => {
                const frame = document.querySelector('iframe');
                frame.contentWindow._testSetAutoplayPersona = persona;
                frame.contentWindow._testSetAutoplay = 'true';
            }
            """,
            self.persona,
        )

    async def disable_autoplay(self) -> None:
        assert self._page is not None
        await self._page.evaluate(
            """
            () => {
                const frame = document.querySelector('iframe');
                frame.contentWindow._testSetAutoplay = 'false';
            }
            """
        )

    async def run(self, duration_s: int) -> None:
        await self.enable_autoplay()
        self.t0 = time.monotonic()
        # AutoPlay's 22s startup delay (Arc-known quirk) — the first ~22s
        # of every recording is static. We still record it for trim context,
        # but downstream clip extractor uses STARTUP_SKIP_S to skip it when
        # picking hero moments.
        await asyncio.sleep(duration_s)
        await self.disable_autoplay()

    async def finalize(self, timeline_path: Path, meta: dict[str, Any]) -> None:
        payload = {
            "meta": {
                **meta,
                "t0_iso": meta.get("t0_iso"),
                "duration_s": time.monotonic() - self.t0,
                "event_count": len(self.events),
                "startup_skip_s": DEFAULT_STARTUP_SKIP_S,
            },
            "events": self.events,
        }
        timeline_path.write_text(json.dumps(payload, indent=2))
        if self._page:
            await self._page.context.browser.close()

    # -- Internal: console event capture --------------------------------------

    def _on_console(self, msg: ConsoleMessage) -> None:
        if self.t0 == 0.0:
            return  # pre-autoplay-start; ignore
        text = msg.text
        for kind, pattern in EVENT_PATTERNS:
            match = pattern.match(text)
            if match:
                self.events.append({
                    "t": time.monotonic() - self.t0,
                    "kind": kind,
                    "payload": match.group(1),
                })
                return


# -- Entrypoint --------------------------------------------------------------


async def main() -> int:
    parser = argparse.ArgumentParser(description="Autoplay capture orchestrator")
    parser.add_argument("--target-url", default=DEFAULT_TARGET_URL)
    parser.add_argument("--fixture", default=DEFAULT_FIXTURE)
    parser.add_argument("--persona", default=DEFAULT_PERSONA)
    parser.add_argument("--duration", type=int, default=DEFAULT_DURATION_S)
    args = parser.parse_args()

    timeline_path = Path(os.environ.get("TIMELINE_PATH", "/home/pwuser/out/capture.timeline.json"))

    print(f"[run.py] target={args.target_url} fixture={args.fixture} persona={args.persona} duration={args.duration}s")

    async with async_playwright() as p:
        session = CaptureSession(args.target_url, args.fixture, args.persona)
        meta = {
            "target_url": args.target_url,
            "fixture": args.fixture,
            "persona": args.persona,
            "t0_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        try:
            await session.boot(p)
            await session.load_fixture()
            await session.run(args.duration)
        finally:
            await session.finalize(timeline_path, meta)

    print(f"[run.py] done: {len(session.events)} events in timeline")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
