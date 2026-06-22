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
import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright, Page, ConsoleMessage


# Unique window title for ffmpeg gdigrab to target. Set on document.title
# after navigation so we can capture Chromium's window contents regardless
# of which monitor it lands on. Chromium in kiosk mode uses the page
# title verbatim as the window title (no " - Chromium" suffix).
CAPTURE_WINDOW_TITLE = os.environ.get("CAPTURE_WINDOW_TITLE", "AllByteCapture")

# -- Config ------------------------------------------------------------------

DEFAULT_TARGET_URL = os.environ.get(
    "TARGET_URL",
    # Use the debug build (default for dev auto-admin) so test hooks
    # like _testImportSave + _testLoadPacks stay available. The visual
    # debug overlay gets hidden via a TestBridge toggle once Arc lands
    # the hook — until then captures may show it, which we crop/edit
    # out for review. The public build was the previous workaround
    # but it strips test hooks the harness depends on.
    "http://localhost:4321/play/",
)
DEFAULT_FIXTURE = os.environ.get("FIXTURE_PATH", "")  # empty = skip fixture load
DEFAULT_PERSONA = os.environ.get("PERSONA", "default")
# Save-fixture URL (Arc-blessed path to skip Title — see
# CON_CLAUDE_TITLE_DISMISS_REPLY.md). Default points at the dev server's
# chroniclesProxy which serves the Chronicles fixture file directly.
# Set to empty to skip and fall back to driving Title manually.
DEFAULT_SAVE_FIXTURE_URL = os.environ.get(
    "SAVE_FIXTURE_URL",
    "http://localhost:4321/test-data/WebTests/fixtures/saves/frontier/cond_01_after_event_1.json",
)
DEFAULT_DURATION_S = int(os.environ.get("DURATION_S", "60"))
DEFAULT_STARTUP_SKIP_S = int(os.environ.get("STARTUP_SKIP_S", "22"))

# Console log patterns we capture as events on the timeline. Arc confirmed
# these are stable Phase 2 grep sources; the formal allbyte:event-* and
# allbyte:walk-* postMessage emits (Phase 4 + walkthrough proposal) will
# run in parallel without retiring these print() lines.
EVENT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("combat", re.compile(r"^\[combat\]\s+(.*)$")),
    ("skill", re.compile(r"^\[skill\]\s+(.*)$")),
    ("autoplay", re.compile(r"^\[AutoPlay\]\s+(.*)$")),
    ("explore", re.compile(r"^\[explore.*?\]\s+(.*)$")),
    ("unit_died", re.compile(r"^\[CombatOverlay\]\s+unit_died:\s+(.*)$")),
    # Walkthrough events — Arc's pending Completionist persona work
    # (APP_CLAUDE_COMPLETIONIST_AND_WALKTHROUGH_EVENTS.md, 2026-06-06).
    # Matches if Arc emits as print() lines; postMessage path is also
    # covered by the listener installed in CaptureSession.boot.
    ("walk", re.compile(r"^\[walk-([a-z-]+)\]\s+(.*)$")),
]


# -- ffmpeg lifecycle --------------------------------------------------------


class FfmpegRecorder:
    """Manages ffmpeg as a subprocess inside run.py instead of in the
    PowerShell wrapper. We do this so we can launch ffmpeg AFTER the
    Chromium window exists with our unique title — gdigrab `title=` mode
    fails if the window doesn't exist yet, and we want to attach to the
    specific window regardless of multi-monitor layout.

    Lifecycle:
        rec = FfmpegRecorder(mp4_path, window_title, audio_device)
        rec.start()       # spawns ffmpeg as a child process
        ... do work ...
        rec.stop()        # sends 'q' to stdin, waits for graceful exit
    """

    def __init__(
        self,
        mp4_path: str,
        window_title: str,
        audio_device: str | None,
        framerate: int = 60,
    ) -> None:
        self.mp4_path = mp4_path
        self.window_title = window_title
        self.audio_device = audio_device
        self.framerate = framerate
        self.proc: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        args: list[str] = [
            "ffmpeg",
            "-hide_banner", "-loglevel", "warning",
            "-f", "gdigrab",
            "-framerate", str(self.framerate),
            "-draw_mouse", "0",
            "-i", f"title={self.window_title}",
        ]
        if self.audio_device:
            args.extend([
                "-f", "dshow",
                "-i", f"audio={self.audio_device}",
            ])
        args.extend([
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
        ])
        if self.audio_device:
            args.extend(["-c:a", "aac", "-b:a", "192k"])
        args.extend(["-y", self.mp4_path])

        # Redirect ffmpeg stderr to a sibling log file so capture
        # failures (window not found, codec issues, etc.) leave a
        # readable trail without polluting the main output stream.
        log_path = Path(self.mp4_path).with_suffix(".ffmpeg.log")
        print(f"[run.py] starting ffmpeg → {self.mp4_path}")
        print(f"[run.py] capture target: title={self.window_title!r}")
        print(f"[run.py] ffmpeg log: {log_path}", flush=True)
        self._log_file = open(log_path, "wb")
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=self._log_file,
            stderr=self._log_file,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )

    def stop(self, timeout_s: float = 8.0) -> int:
        if not self.proc:
            return -1
        # 'q' on stdin = graceful exit (writes MP4 moov atom). Without
        # this ffmpeg can leave the file with no playable index.
        try:
            if self.proc.stdin:
                self.proc.stdin.write(b"q")
                self.proc.stdin.flush()
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            return self.proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            print("[run.py] ffmpeg didn't exit on q; killing", flush=True)
            self.proc.kill()
            try:
                return self.proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                return -1


class CDPScreencastRecorder:
    """Headless-friendly capture: streams Chromium's render frames via the
    Chrome DevTools Protocol's Page.startScreencast and pipes each frame
    to an ffmpeg subprocess as a stream of JPEGs. Used when there's no
    Chromium window to gdigrab (headless mode).

    Pros over gdigrab: no window required, captures Chromium content
    directly regardless of monitor / window position, works in headless
    mode while still using the host GPU through ANGLE/D3D11.

    Cons: no audio (Chromium routes to a null sink in headless), tied
    to CDP's frame rate (typically near 60fps when render keeps up).
    """

    def __init__(
        self,
        page: Page,
        mp4_path: str,
        framerate: int = 60,
        max_width: int = 1920,
        max_height: int = 1080,
        jpeg_quality: int = 85,
    ) -> None:
        self.page = page
        self.mp4_path = mp4_path
        self.framerate = framerate
        self.max_width = max_width
        self.max_height = max_height
        self.jpeg_quality = jpeg_quality
        self.cdp = None
        self.proc: subprocess.Popen[bytes] | None = None
        self._log_file = None
        self._frames_written = 0

    async def start(self) -> None:
        # Open a CDP session against the page.
        self.cdp = await self.page.context.new_cdp_session(self.page)

        log_path = Path(self.mp4_path).with_suffix(".ffmpeg.log")
        self._log_file = open(log_path, "wb")
        # image2pipe with mjpeg accepts a stream of complete JPEG files,
        # one per frame, encoded as raw bytes back-to-back.
        args = [
            "ffmpeg",
            "-hide_banner", "-loglevel", "warning",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-framerate", str(self.framerate),
            "-i", "-",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            "-y", self.mp4_path,
        ]
        print(f"[run.py] starting ffmpeg (image2pipe) → {self.mp4_path}", flush=True)
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=self._log_file,
            stderr=self._log_file,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )

        # Subscribe to screencast frames. The CDP callback is sync;
        # spawn an async task per frame to decode, write, and ack so
        # the next frame can be requested.
        def _on_frame(params):
            asyncio.create_task(self._handle_frame(params))
        self.cdp.on("Page.screencastFrame", _on_frame)

        await self.cdp.send("Page.startScreencast", {
            "format": "jpeg",
            "quality": self.jpeg_quality,
            "maxWidth": self.max_width,
            "maxHeight": self.max_height,
            "everyNthFrame": 1,
        })

    async def _handle_frame(self, params: dict) -> None:
        if not self.proc or not self.proc.stdin:
            return
        try:
            data = base64.b64decode(params["data"])
            self.proc.stdin.write(data)
            self._frames_written += 1
        except (BrokenPipeError, ValueError):
            pass
        # Ack so Chromium emits the next frame. Required — without the
        # ack the screencast pauses.
        try:
            if self.cdp:
                await self.cdp.send("Page.screencastFrameAck", {
                    "sessionId": params["sessionId"],
                })
        except Exception:
            pass

    async def stop(self, timeout_s: float = 10.0) -> int:
        if self.cdp:
            try:
                await self.cdp.send("Page.stopScreencast")
            except Exception:
                pass
        if self.proc and self.proc.stdin:
            try:
                self.proc.stdin.flush()
                self.proc.stdin.close()
            except Exception:
                pass
        rc = -1
        if self.proc:
            try:
                rc = self.proc.wait(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                try:
                    rc = self.proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    rc = -1
        if self._log_file:
            try:
                self._log_file.close()
            except Exception:
                pass
        print(f"[run.py] cdp-screencast wrote {self._frames_written} frames")
        return rc


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
        # Native Windows: Chromium uses the host's GPU. localhost is
        # already a secure origin so no insecure-origin override needed.
        # The anti-throttle flags remain useful (rAF can still get
        # backgrounded if the user clicks away from Chromium).
        headless = os.environ.get("CAPTURE_HEADLESS", "0") == "1"
        # Common args for both visible and headless modes.
        common_args = [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--enable-features=SharedArrayBuffer",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=CalculateNativeWinOcclusion",
            # Force GPU acceleration paths even when Chromium would
            # otherwise blocklist or fall back. Important in headless
            # where the heuristics are conservative.
            "--enable-gpu-rasterization",
            "--ignore-gpu-blocklist",
            "--use-angle=d3d11",
            "--enable-features=Vulkan",
            "--disable-infobars",
            # Let Web Audio start without a click. Godot's HTML5 audio driver
            # still resumes its AudioContext on the first user gesture, but
            # this clears the browser-level autoplay block so a single
            # synthetic gesture (or the title's own audio) isn't fought by
            # Chromium's policy. Needed for title-hold music capture.
            "--autoplay-policy=no-user-gesture-required",
        ]
        if headless:
            # Pure headless. No window, no kiosk, no monitor position.
            # CDP screencast streams frames straight from Chromium's
            # compositor without needing a visible surface.
            args = common_args + [
                "--window-size=1920,1080",
            ]
        else:
            # Visible kiosk on the owner's preferred monitor for the
            # interactive workflow.
            args = common_args + [
                "--kiosk",
                "--start-fullscreen",
                f"--window-position={os.environ.get('CAPTURE_WINDOW_POSITION', '-1920,0')}",
                "--window-size=1920,1080",
            ]
        print(f"[run.py] launching Chromium (headless={headless})", flush=True)
        browser = await playwright.chromium.launch(
            headless=headless,
            args=args,
            ignore_default_args=["--enable-automation"],
        )
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        self._page = await context.new_page()
        self._page.on("console", self._on_console)
        # `domcontentloaded` is the only wait_until that fires reliably here.
        # Godot's bootstrap keeps the network active for tens of seconds while
        # streaming the WASM + PCKs, so `networkidle` and `load` both time out.
        await self._page.goto(self.target_url, wait_until="domcontentloaded", timeout=60_000)
        # Set a unique window title so ffmpeg gdigrab can attach to this
        # specific Chromium window regardless of multi-monitor position
        # or other Chromium instances the owner may have open.
        await self._page.evaluate(
            "(t) => { document.title = t; }", CAPTURE_WINDOW_TITLE
        )
        # Wait for the iframe to mount and the game bootstrapper to be ready.
        # Game posts `allbyte:ready` on init; saves.svelte.ts catches it and
        # flips saves.gameReady to true. We poll a parent-window mirror that
        # this harness installs.
        # Capture-side listener: collects allbyte:ready (boot gate) +
        # allbyte:event-* (Phase 1 emits) + allbyte:walk-* (Completionist
        # walkthrough emits, pending). Stored on parent window queues
        # which run.py drains every poll cycle.
        await self._page.evaluate(
            """
            window.__captureReady = false;
            window.__capture_event_queue = window.__capture_event_queue || [];
            window.__capture_walk_queue = window.__capture_walk_queue || [];
            window.__capture_t0 = performance.now();
            window.addEventListener('message', (e) => {
                const d = e && e.data;
                if (!d || typeof d.type !== 'string') return;
                if (d.type === 'allbyte:ready') { window.__captureReady = true; return; }
                const t = (performance.now() - window.__capture_t0) / 1000;
                if (d.type.startsWith('allbyte:event-')) {
                    window.__capture_event_queue.push({ t, type: d.type, data: d });
                } else if (d.type.startsWith('allbyte:walk-')) {
                    window.__capture_walk_queue.push({ t, type: d.type, data: d });
                }
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

    async def run_title_hold(self, duration_s: int) -> None:
        """Marketing capture of the Title screen itself — no autoplay, no
        dismissal. AutoPlay sits at Title indefinitely on cold boot (see
        load_save_fixture docstring), so we just hold there while the
        recorder rolls: unlock Web Audio with one neutral gesture (Godot's
        AudioContext won't start its title music without a user gesture),
        hide the debug overlay, and wait out the duration."""
        assert self._page is not None

        async def _hud_off():
            try:
                await self._page.evaluate(
                    "() => { const w=document.querySelector('iframe')?.contentWindow;"
                    " if(w) w._testSetGlobalWorldFlag = JSON.stringify({name:'show_pack_overlay', value:false}); }"
                )
            except Exception:
                pass

        await _hud_off()
        # Audio gesture (VISIBLE mode only): Godot's AudioContext needs one
        # user gesture before the title music starts, and visible/gdigrab is
        # the only mode that records audio. Headless captures no audio (frames
        # only — music is muxed in post), so we SKIP the click there to avoid
        # accidentally navigating into a menu and leaving the title screen.
        headless = os.environ.get("CAPTURE_HEADLESS") == "1"
        if not headless:
            iframe = await self._page.query_selector("iframe")
            if iframe:
                box = await iframe.bounding_box()
                if box:
                    # Click bottom-left corner (empty art, clear of the
                    # centered menu buttons) to satisfy the gesture without
                    # advancing. NO Enter key.
                    await self._page.mouse.click(
                        box["x"] + box["width"] * 0.06,
                        box["y"] + box["height"] * 0.92,
                    )
            await asyncio.sleep(0.5)
            scene = await self._page.evaluate(
                "() => { const f = document.querySelector('iframe'); return f?.contentWindow?.gameState?.scene || ''; }"
            )
            if scene and scene != "Title":
                print(f"[run.py] WARN: title-hold gesture advanced to scene={scene!r}")

        self.t0 = time.monotonic()
        elapsed = 0.0
        while elapsed < duration_s:
            await asyncio.sleep(1.0)
            elapsed = time.monotonic() - self.t0
            await _hud_off()

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
        # Marketing-clean: hide the always-on debug overlay (version/MODE/packs/
        # AP/hp panel, bound to GlobalWorld.show_pack_overlay) and suppress
        # scripted scene-entry events so dialogue boxes don't pop mid-capture.
        await self._page.evaluate(
            """() => {
                const w = document.querySelector('iframe')?.contentWindow;
                if (!w) return;
                w._testSetGlobalWorldFlag = JSON.stringify({name: 'show_pack_overlay', value: false});
                w._testSuppressSceneEntryEvents = true;
            }"""
        )
        self.t0 = time.monotonic()

        # Install a self-resetting fps counter in the iframe. It counts
        # rAF callbacks per second — the same loop Godot drives its
        # render off of, so this measures Godot's actual frame delivery
        # rate (not just whatever Chromium thinks the page rate should
        # be). The counter resets every poll, so each read gives the
        # rate over the previous ~1s window.
        await self._page.evaluate(
            """
            () => {
                const f = document.querySelector('iframe');
                const w = f && f.contentWindow;
                if (!w) return;
                if (w.__capture_fps_installed) return;
                w.__capture_fps_installed = true;
                w.__capture_fps_count = 0;
                w.__capture_fps_window_start = performance.now();
                const tick = () => {
                    w.__capture_fps_count++;
                    w.requestAnimationFrame(tick);
                };
                w.requestAnimationFrame(tick);
            }
            """
        )

        elapsed = 0.0
        while elapsed < duration_s:
            await asyncio.sleep(1.0)
            elapsed = time.monotonic() - self.t0
            # Re-assert HUD-off each tick — scene transitions reset GlobalWorld flags.
            try:
                await self._page.evaluate(
                    "() => { const w=document.querySelector('iframe')?.contentWindow;"
                    " if(w) w._testSetGlobalWorldFlag = JSON.stringify({name:'show_pack_overlay', value:false}); }"
                )
            except Exception:
                pass
            # Drain pending allbyte:event-* + allbyte:walk-* postMessage
            # events into the timeline. No-op today (Arc hasn't shipped
            # these emits yet) but ready when they land — same code path
            # picks them up the day they fire.
            try:
                drained = await self._page.evaluate(
                    """() => {
                        const ev = window.__capture_event_queue || [];
                        const wk = window.__capture_walk_queue || [];
                        window.__capture_event_queue = [];
                        window.__capture_walk_queue = [];
                        return { event: ev, walk: wk };
                    }"""
                )
                for ev in drained.get("event", []):
                    self.events.append({
                        "t": float(ev.get("t", elapsed)),
                        "kind": ev["type"].replace("allbyte:event-", "event-"),
                        "payload": json.dumps(ev.get("data", {})),
                    })
                for wk in drained.get("walk", []):
                    self.events.append({
                        "t": float(wk.get("t", elapsed)),
                        "kind": wk["type"].replace("allbyte:walk-", "walk-"),
                        "payload": json.dumps(wk.get("data", {})),
                    })
            except Exception:
                pass
            try:
                # Read+reset the counter atomically. fps is frames over
                # the window since the last read.
                fps = await self._page.evaluate(
                    """
                    () => {
                        const f = document.querySelector('iframe');
                        const w = f && f.contentWindow;
                        if (!w || !w.__capture_fps_installed) return null;
                        const now = performance.now();
                        const dt_ms = now - w.__capture_fps_window_start;
                        const fps = w.__capture_fps_count * 1000 / Math.max(dt_ms, 1);
                        w.__capture_fps_count = 0;
                        w.__capture_fps_window_start = now;
                        return fps;
                    }
                    """
                )
            except Exception:
                fps = None
            if fps is not None:
                # Log as a timeline event so the rate is plottable
                # alongside autoplay events. payload is just the number.
                self.events.append({
                    "t": elapsed,
                    "kind": "fps",
                    "payload": f"{fps:.1f}",
                })

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
    parser.add_argument(
        "--mode", choices=["autoplay", "title"], default="autoplay",
        help="autoplay: drive gameplay (default). title: hold on the Title "
             "screen with music for a marketing showcase clip.",
    )
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
        # Recorder choice: visible mode uses gdigrab attached to the
        # Chromium window; headless mode uses CDP screencast which
        # streams frames directly out of the compositor without
        # needing a visible surface.
        headless = os.environ.get("CAPTURE_HEADLESS", "0") == "1"
        recorder: "FfmpegRecorder | CDPScreencastRecorder | None" = None
        try:
            await session.boot(p)
            mp4_env = os.environ.get("MP4_PATH")
            if mp4_env and os.environ.get("CAPTURE_NO_FFMPEG") != "1":
                framerate = int(os.environ.get("CAPTURE_FRAMERATE", "60"))
                if headless:
                    recorder = CDPScreencastRecorder(
                        page=session._page,
                        mp4_path=mp4_env,
                        framerate=framerate,
                    )
                    await recorder.start()
                else:
                    # Resolve the actual Chromium window title (Playwright
                    # appends " - Google Chrome for Testing") so gdigrab's
                    # exact-match FindWindow works.
                    real_window_title = CAPTURE_WINDOW_TITLE
                    try:
                        probe = subprocess.run(
                            ["powershell", "-NoProfile", "-Command",
                             f"Get-Process | Where-Object {{$_.MainWindowTitle -like '*{CAPTURE_WINDOW_TITLE}*'}} | "
                             f"Select-Object -ExpandProperty MainWindowTitle -First 1"],
                            capture_output=True, text=True, timeout=5,
                        )
                        found = (probe.stdout or "").strip().splitlines()[0] if probe.stdout else ""
                        if found:
                            real_window_title = found
                            print(f"[run.py] resolved window title: {real_window_title!r}", flush=True)
                        else:
                            print(f"[run.py] WARN: no window title matched {CAPTURE_WINDOW_TITLE!r}, "
                                  f"gdigrab may fail.", flush=True)
                    except Exception as e:
                        print(f"[run.py] window probe failed: {e}", flush=True)
                    recorder = FfmpegRecorder(
                        mp4_path=mp4_env,
                        window_title=real_window_title,
                        audio_device=os.environ.get("CAPTURE_AUDIO_DEVICE"),
                        framerate=framerate,
                    )
                    recorder.start()
                # Brief settle so the recorder is producing frames
                # before autoplay starts.
                await asyncio.sleep(0.5)
            if args.mode == "title":
                # Marketing showcase: hold on the Title screen with music.
                await session.run_title_hold(args.duration)
            else:
                if args.fixture:
                    await session.load_fixture()
                await session.run(args.duration, save_fixture_url=args.save_fixture_url)
        finally:
            if recorder:
                if isinstance(recorder, CDPScreencastRecorder):
                    rc = await recorder.stop()
                else:
                    rc = recorder.stop()
                print(f"[run.py] recorder exit={rc}")
            await session.finalize(timeline_path, meta)

    print(f"[run.py] done: {len(session.events)} events in timeline")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
