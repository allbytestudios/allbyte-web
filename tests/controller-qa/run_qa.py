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

from playwright.async_api import Page, async_playwright

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


async def test_controller(page: Page, profile: dict[str, Any]) -> dict[str, Any]:
    """Run a button + axis sweep with the given profile injected."""

    # Install the mock for this profile
    install = await page.evaluate(
        "(p) => window.__qaInstallMock(p)", profile
    )

    # Wait briefly for the connection event to settle and the page to observe it
    await page.wait_for_timeout(150)

    # Confirm navigator.getGamepads() sees it
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

    # Sweep buttons
    button_results: list[dict[str, Any]] = []
    for i in range(profile["numButtons"]):
        name = profile.get("buttonNames", {}).get(str(i), f"B{i}")

        # Press
        await page.evaluate(f"window.__qaSetButton({i}, true)")
        await page.wait_for_timeout(80)
        pressed_dom = await page.evaluate(
            f"document.querySelector('[data-button=\"{i}\"]')?.getAttribute('data-pressed')"
        )

        # Release
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

    # Sweep axes (test 3 values per axis: -1, 0.5, 1)
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
        # Recenter
        await page.evaluate(f"window.__qaSetAxis({i}, 0)")

    # Disconnect cleanly
    await page.evaluate("window.__qaDisconnect()")
    await page.wait_for_timeout(80)

    buttons_passed = sum(1 for b in button_results if b["pass"])
    axes_passed = sum(1 for a in axis_results if a["pass"])

    return {
        "status": "ok",
        "id": profile["id"],
        "seen_id": seen,
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
    print(f"Target: {target_url}")
    print(f"Profiles: {[p['name'] for p in profiles]}")
    print(f"Headed: {not args.headless}")
    print()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=args.headless)
        context = await browser.new_context()
        await context.add_init_script(mock_script)
        page = await context.new_page()

        try:
            await page.goto(target_url, wait_until="domcontentloaded", timeout=15000)
        except Exception as e:
            print(f"ERROR: failed to load {target_url}: {e}", file=sys.stderr)
            await browser.close()
            return 2

        # Verify the init script ran
        installed = await page.evaluate("window.__qaMockInstalled === true")
        if not installed:
            print("ERROR: mock_gamepad.js init script did not run on the page", file=sys.stderr)
            await browser.close()
            return 2

        all_results: list[dict[str, Any]] = []
        for profile in profiles:
            print(f"  Testing {profile['name']}...", end=" ", flush=True)
            try:
                result = await test_controller(page, profile)
                if result["status"] == "ok":
                    s = result["summary"]
                    print(
                        f"buttons {s['buttons_passed']}/{s['buttons_total']}, "
                        f"axes {s['axes_passed']}/{s['axes_total']}"
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
    lines.append("")
    lines.append("## Per-controller results")
    lines.append("")
    lines.append("| Controller | Buttons | Axes | Status |")
    lines.append("|---|---|---|---|")

    for entry in report["results"]:
        r = entry["result"]
        name = entry["profile"]["name"]
        if r["status"] == "ok":
            s = r["summary"]
            status = (
                "PASS"
                if s["buttons_passed"] == s["buttons_total"]
                and s["axes_passed"] == s["axes_total"]
                else "PARTIAL"
            )
            lines.append(
                f"| {name} | {s['buttons_passed']}/{s['buttons_total']} | "
                f"{s['axes_passed']}/{s['axes_total']} | {status} |"
            )
        else:
            lines.append(f"| {name} | — | — | ERROR: {r.get('stage', r.get('error', '?'))} |")

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
