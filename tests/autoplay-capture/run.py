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
DEFAULT_FIXTURE = os.environ.get("FIXTURE_PATH", "")  # empty = skip fixture load
DEFAULT_PERSONA = os.environ.get("PERSONA", "default")
# Save-fixture URL (Arc-blessed path to skip Title — see
# CON_CLAUDE_TITLE_DISMISS_REPLY.md). Default points at the dev server's
# chroniclesProxy which serves the Chronicles fixture file directly.
# Set to empty to skip and fall back to driving Title manually.
DEFAULT_SAVE_FIXTURE_URL = os.environ.get(
    "SAVE_FIXTURE_URL",
    "http://host.docker.internal:4321/test-data/WebTests/fixtures/saves/frontier/cond_01_after_event_1.json",
)
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
        #
        # Xvfb has no GPU, so Chromium falls back to a CPU rasterizer that
        # doesn't expose WebGL2. Godot's web shell sees "WebGL2 missing"
        # and refuses to boot. SwiftShader is Google's software WebGL
        # implementation — adding it as the GL backend lets Godot's
        # capability check pass while staying entirely CPU-side.
        # Xvfb has no GPU, so Chromium needs software WebGL2. Mesa's
        # llvmpipe (set via env in the Dockerfile + --use-gl=desktop) is
        # the CPU rasterizer that lets Godot's web shell pass its WebGL2
        # capability check.
        # Chromium treats `host.docker.internal` as an insecure HTTP origin
        # by default — and Godot's web shell refuses to boot without a
        # secure context (rule: SharedArrayBuffer + crossOriginIsolated
        # require https:// or localhost). The flag below tells Chromium
        # to treat the target as if it were https, which unblocks the
        # secure-context check while still using plain HTTP transport.
        secure_origin = self.target_url.rsplit("/", 1)[0].rstrip("/")
        # The flag expects a comma-separated list of origins. Strip path.
        from urllib.parse import urlparse
        parsed = urlparse(self.target_url)
        secure_origin = f"{parsed.scheme}://{parsed.netloc}"

        browser = await playwright.chromium.launch(
            headless=False,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--use-gl=desktop",
                "--enable-webgl",
                "--ignore-gpu-blocklist",
                "--enable-features=SharedArrayBuffer",
                f"--unsafely-treat-insecure-origin-as-secure={secure_origin}",
            ],
        )
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        self._page = await context.new_page()
        self._page.on("console", self._on_console)
        # `domcontentloaded` is the only wait_until that fires reliably here.
        # Godot's bootstrap keeps the network active for tens of seconds while
        # streaming the WASM + PCKs, so `networkidle` and `load` both time out.
        await self._page.goto(self.target_url, wait_until="domcontentloaded", timeout=60_000)
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
        # Godot boot can take 30-90s depending on connection (PCKs are large
        # and stream over multiple HTTP requests). Give it real headroom.
        try:
            await self._page.wait_for_function(
                "() => window.__captureReady === true", timeout=120_000
            )
        except Exception:
            # Dump diagnostics so we can see WHY the game didn't boot.
            # Most useful: the iframe's bootstrap shell text (which contains
            # the missing-features list when Engine.getMissingFeatures fires).
            diag = await self._page.evaluate(
                """
                () => {
                    const out = { url: location.href, parentText: '', iframeText: '', iframeUrl: '' };
                    try {
                        const f = document.querySelector('iframe');
                        if (f) {
                            out.iframeUrl = f.src;
                            try { out.iframeText = (f.contentDocument?.body?.innerText || '').slice(0, 2000); } catch (e) { out.iframeText = 'cross-origin: ' + e.message; }
                        }
                        out.parentText = (document.body.innerText || '').slice(0, 2000);
                    } catch (e) { out.error = e.message; }
                    return out;
                }
                """
            )
            print("[run.py] BOOT TIMEOUT — diagnostics:")
            print("  url:", diag.get("url"))
            print("  iframe url:", diag.get("iframeUrl"))
            print("  parent text:", repr((diag.get("parentText") or "")[:400]))
            print("  iframe text:", repr((diag.get("iframeText") or "")[:1200]))
            raise

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

    async def load_save_fixture(self, fixture_url: str) -> bool:
        """Arc-blessed path to skip Title (CON_CLAUDE_TITLE_DISMISS_REPLY.md):
        mount the Laria pack → fetch save fixture JSON → import as slot 99 →
        load slot. Returns True if the import succeeded.

        Without this, AutoPlay sits at Title screen indefinitely — the
        section script handles Title→playable but the cold-boot input
        sequence is brittle from a Playwright-driven harness."""
        assert self._page is not None
        # Fetch the fixture from the dev server (chroniclesProxy serves
        # Chronicles repo files at /test-data/*).
        try:
            fixture_data = await self._page.evaluate(
                """async (url) => {
                    const r = await fetch(url);
                    if (!r.ok) throw new Error('fixture fetch ' + r.status);
                    return await r.json();
                }""",
                fixture_url,
            )
        except Exception as e:
            print(f"[run.py] save fixture fetch failed: {e}")
            return False

        # 1. Mount the Laria zone pack.
        await self._page.evaluate(
            """() => {
                const f = document.querySelector('iframe');
                f.contentWindow._testLoadPacks = 'Laria';
            }"""
        )
        # 2. Wait for packsLoaded to include 'Laria' (Arc says ~400ms warm,
        # allow up to 10s for cold boot).
        try:
            await self._page.wait_for_function(
                """() => {
                    const f = document.querySelector('iframe');
                    const packs = f?.contentWindow?.gameState?.packsLoaded || [];
                    return Array.isArray(packs) && packs.includes('Laria');
                }""",
                timeout=10_000,
            )
        except Exception as e:
            print(f"[run.py] Laria pack mount timeout: {e}")
            return False
        # 3. Import the save bytes.
        await self._page.evaluate(
            """(data) => {
                const f = document.querySelector('iframe');
                f.contentWindow._testImportSave = JSON.stringify({slot: 99, data});
            }""",
            fixture_data,
        )
        # 4. Load the slot.
        await self._page.evaluate(
            """() => {
                const f = document.querySelector('iframe');
                f.contentWindow._testLoadGame = 99;
            }"""
        )
        # Wait for scene transition (~800ms per Arc; pad to 2s).
        await asyncio.sleep(2)
        return True

    async def dismiss_title(self, max_attempts: int = 8) -> None:
        """Fallback when save-fixture import isn't available. Click the
        iframe canvas + tap Enter until the scene transitions out of Title.
        Empirical and brittle — prefer load_save_fixture when possible."""
        assert self._page is not None
        iframe = await self._page.query_selector("iframe")
        if not iframe:
            print("[run.py] dismiss_title: no iframe found")
            return
        # Give the iframe canvas keyboard focus.
        box = await iframe.bounding_box()
        if box:
            await self._page.mouse.click(
                box["x"] + box["width"] / 2,
                box["y"] + box["height"] / 2,
            )
        await asyncio.sleep(0.5)
        # Tap Enter repeatedly. Title flows can have a logo screen + menu
        # so multiple presses may be needed. Stop as soon as scene changes.
        for i in range(max_attempts):
            await self._page.keyboard.press("Enter")
            await asyncio.sleep(1.5)
            scene = await self._page.evaluate(
                "() => { const f = document.querySelector('iframe'); return f?.contentWindow?.gameState?.scene || ''; }"
            )
            if scene and scene != "Title":
                print(f"[run.py] dismiss_title: scene = {scene!r} after {i+1} press(es)")
                return
        print(f"[run.py] dismiss_title: stayed at Title after {max_attempts} attempts")

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

    async def run(self, duration_s: int, save_fixture_url: str = "") -> None:
        # Skip Title via Arc-blessed save-import. Falls back to empirical
        # Title dismissal if the fixture URL is empty or the fetch fails.
        loaded = False
        if save_fixture_url:
            loaded = await self.load_save_fixture(save_fixture_url)
        if not loaded:
            await self.dismiss_title()
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
    parser.add_argument("--save-fixture-url", default=DEFAULT_SAVE_FIXTURE_URL)
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
            if args.fixture:
                await session.load_fixture()
            await session.run(args.duration, save_fixture_url=args.save_fixture_url)
        finally:
            await session.finalize(timeline_path, meta)

    print(f"[run.py] done: {len(session.events)} events in timeline")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
