"""Controller QA harness — Playwright + Gamepad API mocking.

Loops over a set of controller profiles, injects each one as a mock
gamepad into the target page via the mock_gamepad.js init script, and
sweeps every button + every axis to confirm the page receives the
events correctly. Writes a JSON + Markdown report per run.

Usage:
  python tests/controller-qa/run_qa.py                       # against tester.html (file://)
  python tests/controller-qa/run_qa.py --target local        # against http://localhost:4321/play/
  python tests/controller-qa/run_qa.py --target prod         # against https://allbyte.studio/play/
  python tests/controller-qa/run_qa.py --controllers xbox360,dualsense
  python tests/controller-qa/run_qa.py --headless            # default is headed; some browsers need headed for Gamepad API

Requirements:
  pip install playwright
  playwright install chromium

Exit code:
  0 = all profiles passed
  1 = at least one profile had a failure
  2 = setup error (target unreachable, init script not injected, etc.)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from playwright.async_api import Frame, Page, async_playwright

BASE = Path(__file__).parent
CONTROLLERS_PATH = BASE / "controllers.json"
MOCK_SCRIPT_PATH = BASE / "mock_gamepad.js"
REPORTS_DIR = BASE / "reports"

DEFAULT_TESTER_URL = f"file://{(BASE / 'tester.html').resolve()}"

TARGET_URLS = {
    "tester": DEFAULT_TESTER_URL,
    "local": "http://localhost:4321/play/",
    "prod": "https://allbyte.studio/play/",
}


def is_play_target(url: str) -> bool:
    """Detect whether the URL points at the live Godot play page.

    The play page hosts the game in an iframe and has no DOM tester
    elements — verification semantics differ accordingly.
    """
    return url.rstrip("/").endswith("/play")


async def find_godot_iframe(page: Page, timeout_ms: int = 20000) -> Frame:
    """Wait for the Godot iframe to appear and return its Frame handle."""
    await page.wait_for_selector("iframe", timeout=timeout_ms)
    iframe_handle = await page.query_selector("iframe")
    if iframe_handle is None:
        raise RuntimeError("Could not find Godot iframe element on /play/")
    frame = await iframe_handle.content_frame()
    if frame is None:
        raise RuntimeError("iframe element found but content_frame() is None")
    return frame


async def wait_for_godot_ready(
    page: Page, frame: Frame, timeout_ms: int = 60000
) -> str:
    """Wait for Godot to finish booting to a real scene.

    `gameState` lives on the IFRAME's window (set by Godot's HTML5
    runtime), not the parent. Matches the pattern used by
    `scripts/smoke_prod.py`. Returns the name of the reached scene
    (typically "Title").
    """
    poll_s = 1
    elapsed_ms = 0
    while elapsed_ms < timeout_ms:
        await page.wait_for_timeout(poll_s * 1000)
        elapsed_ms += poll_s * 1000
        try:
            scene = await frame.evaluate("window.gameState?.scene || null")
        except Exception:
            scene = None
        if scene:
            return scene
    raise TimeoutError(
        f"Godot did not reach a scene within {timeout_ms / 1000:.0f}s"
    )


async def activate_iframe(page: Page) -> None:
    """Click the Godot iframe to register user activation.

    Required by the Gamepad API — `navigator.getGamepads()` returns nothing
    until the frame has received user activation. The mock works regardless
    in most cases (we're injecting the function ourselves), but firing
    `gamepadconnected` events legitimately is gated on activation in some
    Chromium versions.
    """
    iframe_handle = await page.query_selector("iframe")
    if iframe_handle is None:
        return
    box = await iframe_handle.bounding_box()
    if box is None:
        return
    await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    await page.wait_for_timeout(100)


def profile_slug(profile: dict[str, Any]) -> str:
    """Stable short id derived from the profile name."""
    return (
        profile["name"]
        .lower()
        .replace(" ", "-")
        .replace("(", "")
        .replace(")", "")
        .replace("/", "-")
    )


async def test_controller_tester(
    page: Page, profile: dict[str, Any]
) -> dict[str, Any]:
    """Run a button + axis sweep against tester.html.

    Verifies each input via the DOM attributes the tester page renders
    (`data-button`, `data-pressed`, `data-axis`, `data-value`).
    """

    await page.evaluate("(p) => window.__qaInstallMock(p)", profile)
    await page.wait_for_timeout(150)

    seen = await page.evaluate("navigator.getGamepads()[0]?.id")
    if seen != profile["id"]:
        return {
            "status": "error",
            "stage": "install",
            "expected_id": profile["id"],
            "seen_id": seen,
            "buttons": [],
            "axes": [],
        }

    button_results: list[dict[str, Any]] = []
    for i in range(profile["numButtons"]):
        name = profile.get("buttonNames", {}).get(str(i), f"B{i}")

        await page.evaluate(f"window.__qaSetButton({i}, true)")
        await page.wait_for_timeout(80)
        pressed_dom = await page.evaluate(
            f"document.querySelector('[data-button=\"{i}\"]')?.getAttribute('data-pressed')"
        )

        await page.evaluate(f"window.__qaSetButton({i}, false)")
        await page.wait_for_timeout(40)
        released_dom = await page.evaluate(
            f"document.querySelector('[data-button=\"{i}\"]')?.getAttribute('data-pressed')"
        )

        button_results.append(
            {
                "index": i,
                "name": name,
                "press_registered": pressed_dom == "true",
                "release_registered": released_dom == "false",
                "pass": pressed_dom == "true" and released_dom == "false",
            }
        )

    axis_results: list[dict[str, Any]] = []
    for i in range(profile["numAxes"]):
        for set_value in [-1.0, 0.5, 1.0]:
            await page.evaluate(f"window.__qaSetAxis({i}, {set_value})")
            await page.wait_for_timeout(60)
            seen_value_str = await page.evaluate(
                f"document.querySelector('[data-axis=\"{i}\"]')?.getAttribute('data-value')"
            )
            try:
                seen_value = float(seen_value_str) if seen_value_str else None
            except (TypeError, ValueError):
                seen_value = None
            tolerance = 0.005
            axis_results.append(
                {
                    "index": i,
                    "set": set_value,
                    "seen": seen_value,
                    "pass": seen_value is not None
                    and abs(seen_value - set_value) <= tolerance,
                }
            )
        await page.evaluate(f"window.__qaSetAxis({i}, 0)")

    await page.evaluate("window.__qaDisconnect()")
    await page.wait_for_timeout(80)

    return _summarize(profile, seen, button_results, axis_results)


async def test_controller_play(
    page: Page, frame: Frame, profile: dict[str, Any]
) -> dict[str, Any]:
    """Run a button + axis sweep against the live /play/ Godot iframe.

    Verification is weaker than tester mode because the running game
    doesn't expose per-input state in a way we can read from the outside.
    What this DOES verify:

    - The mock gamepad installed successfully in the iframe context
    - Each press/release call returns from `__qaSetButton` without throwing
    - The mock state stays consistent with what we set (round-trips via
      `__qaGetMockState()`)
    - The game survives the full sweep — `window.gameState.scene` (read
      from the PARENT page) is still set and unchanged from before
    - No new errors appear in `_consoleLogs` during the sweep

    What this CANNOT verify without game-side instrumentation:

    - Whether Chronicles' InputMap actually fired the corresponding
      InputAction in response. That requires Arc to add a debug print
      on input events, which the harness can then grep for in
      `_consoleLogs`. Documented as the v2 step.
    """

    # Capture pre-sweep state. gameState and _consoleLogs both live on the
    # iframe's window (Godot runtime + the dev-console interceptor in
    # index.html), not on the parent.
    scene_before = await frame.evaluate("window.gameState?.scene")
    logs_before_count = await frame.evaluate(
        "(window._consoleLogs?.length) || 0"
    )

    # Install the mock in the iframe (where Godot is polling getGamepads)
    install = await frame.evaluate(
        "(p) => window.__qaInstallMock(p)", profile
    )
    await page.wait_for_timeout(200)

    seen = await frame.evaluate("navigator.getGamepads()[0]?.id")
    if seen != profile["id"]:
        return {
            "status": "error",
            "stage": "install",
            "expected_id": profile["id"],
            "seen_id": seen,
            "buttons": [],
            "axes": [],
        }

    button_results: list[dict[str, Any]] = []
    for i in range(profile["numButtons"]):
        name = profile.get("buttonNames", {}).get(str(i), f"B{i}")

        try:
            await frame.evaluate(f"window.__qaSetButton({i}, true)")
            await page.wait_for_timeout(60)
            state_pressed = await frame.evaluate(
                f"(window.__qaGetMockState()?.buttonsPressed?.[{i}]) === true"
            )

            await frame.evaluate(f"window.__qaSetButton({i}, false)")
            await page.wait_for_timeout(30)
            state_released = await frame.evaluate(
                f"(window.__qaGetMockState()?.buttonsPressed?.[{i}]) === false"
            )

            button_results.append(
                {
                    "index": i,
                    "name": name,
                    "press_registered": state_pressed,
                    "release_registered": state_released,
                    "pass": state_pressed and state_released,
                }
            )
        except Exception as e:
            button_results.append(
                {
                    "index": i,
                    "name": name,
                    "press_registered": False,
                    "release_registered": False,
                    "pass": False,
                    "error": str(e),
                }
            )

    axis_results: list[dict[str, Any]] = []
    for i in range(profile["numAxes"]):
        for set_value in [-1.0, 0.5, 1.0]:
            try:
                await frame.evaluate(f"window.__qaSetAxis({i}, {set_value})")
                await page.wait_for_timeout(50)
                seen_value = await frame.evaluate(
                    f"window.__qaGetMockState()?.axes?.[{i}]"
                )
                if seen_value is None:
                    pass_ok = False
                else:
                    pass_ok = abs(float(seen_value) - set_value) <= 0.005
                axis_results.append(
                    {"index": i, "set": set_value, "seen": seen_value, "pass": pass_ok}
                )
            except Exception as e:
                axis_results.append(
                    {
                        "index": i,
                        "set": set_value,
                        "seen": None,
                        "pass": False,
                        "error": str(e),
                    }
                )
        await frame.evaluate(f"window.__qaSetAxis({i}, 0)")

    await frame.evaluate("window.__qaDisconnect()")
    # Longer settle so Godot fully processes the disconnect before the
    # next profile installs. Without this, the iframe can detach
    # between profiles (suspected: Godot internal teardown reacting to
    # quick connect/disconnect cycles).
    await page.wait_for_timeout(800)

    # Post-sweep liveness checks (still read from iframe context)
    scene_after = await frame.evaluate("window.gameState?.scene")
    logs_after_count = await frame.evaluate(
        "(window._consoleLogs?.length) || 0"
    )
    new_logs: list[str] = []
    if logs_after_count > logs_before_count:
        new_logs = (
            await frame.evaluate(
                f"(window._consoleLogs || []).slice({logs_before_count}, {logs_after_count})"
            )
            or []
        )
    # Two-tier classification: "fatal" patterns that genuinely indicate the
    # game broke vs. "noisy" Godot runtime warnings that are informational
    # only. We only flip status to "partial" on fatal patterns. The noisy
    # bucket gets counted so it's visible in the report, but doesn't fail
    # the test — Godot logs verbose ERROR-prefixed warnings for many
    # non-fatal conditions (Parse JSON failed, etc.) that don't affect
    # gameplay.
    fatal_patterns = [
        "MD5 sum of the decrypted file does not match",
        "Can't open encrypted pack-referenced file",
        "ERROR: open_and_parse",
        "Cannot get class",
        "Uncaught",
        "TypeError",
        "ReferenceError",
        "SCRIPT ERROR",
    ]
    informational_patterns = [
        "ERROR: Parse JSON failed",
        "ERROR:",  # catch-all — any other ERROR-prefixed line that didn't match fatal
    ]
    fatal_errors = [
        log
        for log in new_logs
        if any(pat in str(log) for pat in fatal_patterns)
    ]
    info_errors = [
        log
        for log in new_logs
        if any(pat in str(log) for pat in informational_patterns)
        and not any(pat in str(log) for pat in fatal_patterns)
    ]

    result = _summarize(profile, seen, button_results, axis_results)
    result["liveness"] = {
        "scene_before": scene_before,
        "scene_after": scene_after,
        "game_still_alive": bool(scene_after),
        "new_console_logs": len(new_logs),
        "fatal_error_logs": len(fatal_errors),
        "informational_logs": len(info_errors),
        "fatal_samples": fatal_errors[:5],
        "informational_samples": info_errors[:3],
    }
    if not result["liveness"]["game_still_alive"] or fatal_errors:
        result["status"] = "partial"
    return result


def _summarize(
    profile: dict[str, Any],
    seen_id: Any,
    button_results: list[dict[str, Any]],
    axis_results: list[dict[str, Any]],
) -> dict[str, Any]:
    buttons_passed = sum(1 for b in button_results if b["pass"])
    axes_passed = sum(1 for a in axis_results if a["pass"])
    return {
        "status": "ok",
        "id": profile["id"],
        "seen_id": seen_id,
        "buttons": button_results,
        "axes": axis_results,
        "summary": {
            "buttons_passed": buttons_passed,
            "buttons_total": len(button_results),
            "axes_passed": axes_passed,
            "axes_total": len(axis_results),
        },
    }


async def run(args: argparse.Namespace) -> int:
    profiles = json.loads(CONTROLLERS_PATH.read_text())
    mock_script = MOCK_SCRIPT_PATH.read_text()

    # Filter profiles if requested
    if args.controllers:
        wanted = set(args.controllers.split(","))
        profiles = [p for p in profiles if profile_slug(p) in wanted or p["name"] in wanted]
        if not profiles:
            print(f"ERROR: no profiles matched --controllers={args.controllers}", file=sys.stderr)
            return 2

    target_url = TARGET_URLS.get(args.target, args.target)
    play_mode = is_play_target(target_url)
    print(f"Target: {target_url}")
    print(f"Mode:   {'play (live Godot iframe)' if play_mode else 'tester (standalone HTML)'}")
    print(f"Profiles: {[p['name'] for p in profiles]}")
    print(f"Headed: {not args.headless}")
    print()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=args.headless)
        context = await browser.new_context()
        await context.add_init_script(mock_script)
        page = await context.new_page()

        try:
            # `domcontentloaded` for both modes. Play page in particular
            # never reaches networkidle because the Godot runtime keeps
            # streaming PCK and asset data — relying on networkidle would
            # hang indefinitely.
            await page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            print(f"ERROR: failed to load {target_url}: {e}", file=sys.stderr)
            await browser.close()
            return 2

        frame: Frame | None = None

        if play_mode:
            # Get the iframe Frame handle first — wait_for_godot_ready needs
            # it to poll gameState in the right window context.
            try:
                frame = await find_godot_iframe(page)
            except Exception as e:
                print(f"ERROR: failed to obtain Godot iframe Frame: {e}", file=sys.stderr)
                await browser.close()
                return 2

            # Wait for Godot to boot to a real scene
            try:
                print("  Waiting for Godot boot...", end=" ", flush=True)
                scene = await wait_for_godot_ready(page, frame, timeout_ms=60000)
                print(f"OK (scene={scene})")
            except Exception as e:
                print(f"\nERROR: {e}", file=sys.stderr)
                await browser.close()
                return 2

            # Register user activation on the iframe so subsequent gamepad
            # events propagate cleanly (some Chromium versions gate
            # gamepadconnected dispatch on activation).
            await activate_iframe(page)

            # Verify the init script ran INSIDE the iframe (Playwright's
            # add_init_script applies to all frames at load, so this should
            # pass — but verify to surface any framework issues early).
            installed = await frame.evaluate("window.__qaMockInstalled === true")
            if not installed:
                print(
                    "ERROR: mock_gamepad.js init script did not run in the Godot iframe",
                    file=sys.stderr,
                )
                await browser.close()
                return 2
        else:
            # Tester mode — init script runs on the main page itself
            installed = await page.evaluate("window.__qaMockInstalled === true")
            if not installed:
                print("ERROR: mock_gamepad.js init script did not run on tester page", file=sys.stderr)
                await browser.close()
                return 2

        all_results: list[dict[str, Any]] = []
        for idx, profile in enumerate(profiles):
            print(f"  Testing {profile['name']}...", end=" ", flush=True)
            try:
                if play_mode:
                    # Empirically, Godot's HTML5 runtime detaches the iframe
                    # after ~2 mock connect/disconnect cycles (cause not
                    # fully understood — possibly internal teardown reacting
                    # to repeated gamepadconnected events). Workaround: reload
                    # the page before every controller after the first so each
                    # profile starts from a fresh Godot boot. Slow but reliable
                    # (~30s per profile on prod cold-cache, ~5s warm).
                    if idx > 0:
                        print("[reload]", end=" ", flush=True)
                        try:
                            await page.reload(wait_until="domcontentloaded", timeout=30000)
                            frame = await find_godot_iframe(page, timeout_ms=10000)
                            scene = await wait_for_godot_ready(page, frame, timeout_ms=60000)
                            await activate_iframe(page)
                            # Re-fetch frame after activation click (Playwright handle
                            # can also invalidate after focus change)
                            frame = await find_godot_iframe(page, timeout_ms=5000)
                        except Exception as e:
                            all_results.append(
                                {
                                    "profile": profile,
                                    "result": {
                                        "status": "exception",
                                        "error": f"reload + boot failed: {e}",
                                    },
                                }
                            )
                            print(f"EXCEPTION on reload: {e}")
                            continue
                    assert frame is not None
                    result = await test_controller_play(page, frame, profile)
                else:
                    result = await test_controller_tester(page, profile)

                if result["status"] in ("ok", "partial"):
                    s = result["summary"]
                    suffix = ""
                    if play_mode and "liveness" in result:
                        liv = result["liveness"]
                        if not liv["game_still_alive"]:
                            suffix = " [GAME DIED]"
                        elif liv["fatal_error_logs"] > 0:
                            suffix = f" [{liv['fatal_error_logs']} FATAL errors]"
                        elif liv["informational_logs"] > 0:
                            suffix = f" ({liv['informational_logs']} info warnings)"
                    print(
                        f"buttons {s['buttons_passed']}/{s['buttons_total']}, "
                        f"axes {s['axes_passed']}/{s['axes_total']}{suffix}"
                    )
                else:
                    print(f"ERROR ({result.get('stage', '?')})")
                all_results.append({"profile": profile, "result": result})
            except Exception as e:
                print(f"EXCEPTION: {e}")
                all_results.append(
                    {
                        "profile": profile,
                        "result": {"status": "exception", "error": str(e)},
                    }
                )

        await browser.close()

    # Write report
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out_dir = REPORTS_DIR / timestamp
    out_dir.mkdir(parents=True, exist_ok=True)

    report = {
        "timestamp": timestamp,
        "target": target_url,
        "headless": args.headless,
        "results": all_results,
    }
    (out_dir / "results.json").write_text(json.dumps(report, indent=2))
    write_markdown_report(out_dir / "report.md", report)

    # Determine exit code
    any_failed = False
    print("\n=== Summary ===")
    for entry in all_results:
        r = entry["result"]
        name = entry["profile"]["name"]
        if r["status"] == "ok":
            s = r["summary"]
            all_pass = (
                s["buttons_passed"] == s["buttons_total"]
                and s["axes_passed"] == s["axes_total"]
            )
            mark = "OK" if all_pass else "PARTIAL"
            if not all_pass:
                any_failed = True
            print(
                f"  [{mark}] {name}: "
                f"buttons {s['buttons_passed']}/{s['buttons_total']}, "
                f"axes {s['axes_passed']}/{s['axes_total']}"
            )
        else:
            any_failed = True
            print(f"  [ERROR] {name}: {r.get('error', r.get('stage', '?'))}")

    print(f"\nReport: {out_dir / 'report.md'}")
    print(f"Raw:    {out_dir / 'results.json'}")

    return 1 if any_failed else 0


def write_markdown_report(path: Path, report: dict[str, Any]) -> None:
    """Render a human-readable summary of the QA run."""
    lines: list[str] = []
    lines.append("# Controller QA Run")
    lines.append("")
    lines.append(f"- **Timestamp:** {report['timestamp']}")
    lines.append(f"- **Target:** `{report['target']}`")
    lines.append(f"- **Headless:** {report['headless']}")

    play_mode = any(
        "liveness" in entry["result"] for entry in report["results"]
    )
    if play_mode:
        lines.append(
            f"- **Mode:** play (live Godot iframe — verification is"
            f" 'game still alive' + 'mock state round-trips'; specific"
            f" InputAction firing requires game-side instrumentation"
            f" not yet wired)"
        )
    lines.append("")
    lines.append("## Per-controller results")
    lines.append("")
    if play_mode:
        lines.append("| Controller | Buttons | Axes | Game alive | Fatal | Info warnings | Status |")
        lines.append("|---|---|---|---|---|---|---|")
    else:
        lines.append("| Controller | Buttons | Axes | Status |")
        lines.append("|---|---|---|---|")

    for entry in report["results"]:
        r = entry["result"]
        name = entry["profile"]["name"]
        if r["status"] in ("ok", "partial"):
            s = r["summary"]
            all_inputs_pass = (
                s["buttons_passed"] == s["buttons_total"]
                and s["axes_passed"] == s["axes_total"]
            )
            if play_mode and "liveness" in r:
                liv = r["liveness"]
                status = (
                    "PASS"
                    if all_inputs_pass
                    and liv["game_still_alive"]
                    and liv["fatal_error_logs"] == 0
                    else "PARTIAL"
                )
                lines.append(
                    f"| {name} | {s['buttons_passed']}/{s['buttons_total']} | "
                    f"{s['axes_passed']}/{s['axes_total']} | "
                    f"{'yes' if liv['game_still_alive'] else 'NO'} | "
                    f"{liv['fatal_error_logs']} | "
                    f"{liv['informational_logs']} | {status} |"
                )
            else:
                status = "PASS" if all_inputs_pass else "PARTIAL"
                lines.append(
                    f"| {name} | {s['buttons_passed']}/{s['buttons_total']} | "
                    f"{s['axes_passed']}/{s['axes_total']} | {status} |"
                )
        else:
            extra = ""
            if play_mode:
                extra = " | — | — | —"
            lines.append(
                f"| {name} | — | — | ERROR: {r.get('stage', r.get('error', '?'))}{extra} |"
            )

    # Detail on any non-passing buttons/axes
    lines.append("")
    lines.append("## Failure details")
    lines.append("")
    any_detail = False
    for entry in report["results"]:
        r = entry["result"]
        if r["status"] != "ok":
            any_detail = True
            lines.append(f"### {entry['profile']['name']} — {r['status']}")
            lines.append(f"  {r}")
            continue
        failed_buttons = [b for b in r["buttons"] if not b["pass"]]
        failed_axes = [a for a in r["axes"] if not a["pass"]]
        if failed_buttons or failed_axes:
            any_detail = True
            lines.append(f"### {entry['profile']['name']}")
            for b in failed_buttons:
                lines.append(
                    f"- Button {b['index']} ({b['name']}): "
                    f"press={b['press_registered']}, release={b['release_registered']}"
                )
            for a in failed_axes:
                lines.append(
                    f"- Axis {a['index']}: set={a['set']}, seen={a['seen']}"
                )
    if not any_detail:
        lines.append("_All profiles passed cleanly._")

    path.write_text("\n".join(lines) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description="Controller QA harness")
    ap.add_argument(
        "--target",
        default="tester",
        help="One of: tester (default, file://tester.html), local, prod, or any URL",
    )
    ap.add_argument(
        "--controllers",
        default="",
        help="Comma-separated profile slugs or names to test (default: all)",
    )
    ap.add_argument(
        "--headless",
        action="store_true",
        help="Run browser headless (default: headed — required for some Gamepad API behaviors)",
    )
    args = ap.parse_args()

    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
