#!/usr/bin/env python3
"""copilot2_watchdog.py — keep the owner-watched shared Chrome window alive.

    python scripts/copilot2_watchdog.py                 # run in the foreground
    python scripts/copilot2_watchdog.py --once          # single check, then exit
    python scripts/copilot2_watchdog.py --interval 30   # default 30s

WHAT IT WATCHES ------------------------------------------------------------------

The host Chrome window the owner watches and Quinn drives over CDP
(http://localhost:8060/?copilot=2&shared=quinn, CDP on 9224). See
reference_copilot2_shared_chrome in the session memory.

It handles TWO distinct failures, which look the same from Quinn's side:

  1. DEAD    — Chrome exited (window closed, host rebooted). CDP refuses.
  2. WEDGED  — Chrome is fine and CDP answers, but the WASM/JS thread is blocked,
               so every page.evaluate times out. Seen 2026-09-17 when a combat
               verb polled 240s for a targeting mode that never arrived.

WHY A PLAIN RELOAD IS NOT THE FIX: window.location.reload() runs ON the blocked
thread and queues behind whatever is hung, so it silently no-ops. The only
reliable recycle is at the BROWSER process level — close the page target over
CDP HTTP (which the blocked thread is not involved in), then relaunch.

WHY THE PROBE RUNS IN A SUBPROCESS: connecting to a wedged renderer can hang the
client itself — Playwright's connect_over_cdp handshake died outright against
one. A watchdog that can hang is not a watchdog, so the probe is isolated behind
a hard timeout and its death is simply read as "wedged".

SAFETY: it only ever touches the Chrome instance owning CDP port 9224, launched
with the dedicated copilot2-chrome profile. The owner's normal Chrome (different
profile, no CDP port) is never inspected, never closed, never killed.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

# Defaults describe the owner-watched window; all three are overridable so the
# destructive paths (kill / relaunch) can be exercised against a throwaway
# instance rather than the live session someone is watching.
CDP_PORT = int(os.environ.get("COPILOT2_PORT", "9224"))
CDP = f"http://127.0.0.1:{CDP_PORT}"
URL = os.environ.get("COPILOT2_URL", "http://localhost:8060/?copilot=2&shared=quinn")
PROFILE = os.environ.get(
    "COPILOT2_PROFILE",
    os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "copilot2-chrome"),
)
CHROME_CANDIDATES = [
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
]
# Generous: a cold Godot boot legitimately takes ~10s+ on this build, and a
# false "wedged" verdict would recycle a window that was merely still loading.
PROBE_TIMEOUT_S = 25
LOG = os.path.join(os.environ.get("TEMP", "."), "copilot2-watchdog.log")


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def chrome_path() -> str | None:
    for p in CHROME_CANDIDATES:
        if p and os.path.exists(p):
            return p
    return None


def cdp_alive() -> bool:
    try:
        with urllib.request.urlopen(f"{CDP}/json/version", timeout=5):
            return True
    except Exception:
        return False


def page_targets() -> list[dict]:
    try:
        with urllib.request.urlopen(f"{CDP}/json/list", timeout=5) as r:
            return [t for t in json.load(r) if t.get("type") == "page"]
    except Exception:
        return []


PROBE_SRC = """
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp("%s")
    pages = [x for x in b.contexts[0].pages if "8060" in x.url]
    if not pages:
        print("NOPAGE"); sys.exit(2)
    pg = pages[0]
    pg.set_default_timeout(4000)
    pg.evaluate("1+1")
    try:
        ready = pg.evaluate("!!(window.gameState && window.gameState.ready)")
        scene = pg.evaluate("window.gameState && window.gameState.scene")
    except Exception:
        ready, scene = False, None
    print("OK", ready, scene)
    b.close()
""" % CDP


def responsive() -> tuple[bool, str]:
    """True if the page's JS thread answers. Isolated in a subprocess with a hard
    timeout because a wedged renderer can hang the CLIENT, not just the page."""
    try:
        out = subprocess.run(
            [sys.executable, "-c", PROBE_SRC],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return False, "probe timed out — JS thread blocked"
    txt = (out.stdout or "").strip().splitlines()
    last = txt[-1] if txt else ""
    if last.startswith("OK"):
        return True, last
    if last == "NOPAGE":
        return False, "no :8060 page target"
    return False, f"probe failed rc={out.returncode} {(out.stderr or '')[-120:].strip()}"


def kill_cdp_chrome() -> None:
    """Kill ONLY the Chrome that owns our CDP port. The owner's normal Chrome has
    no CDP port and a different profile, so it is never a candidate."""
    ps = (
        f"$c = Get-NetTCPConnection -LocalPort {CDP_PORT} -State Listen "
        f"-ErrorAction SilentlyContinue; if ($c) {{ "
        f"Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue; "
        f"'killed ' + $c[0].OwningProcess }} else {{ 'nothing on port' }}"
    )
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True, timeout=30)
        log(f"  kill: {(r.stdout or '').strip()}")
    except Exception as e:
        log(f"  kill failed: {e}")


def launch() -> bool:
    exe = chrome_path()
    if not exe:
        log("  CANNOT LAUNCH — chrome.exe not found")
        return False
    os.makedirs(PROFILE, exist_ok=True)
    args = [
        exe,
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={PROFILE}",
        "--no-first-run", "--no-default-browser-check", "--new-window",
        "--window-position=0,0", "--window-size=1400,950",
        URL,
    ]
    try:
        subprocess.Popen(args, close_fds=True)
    except Exception as e:
        log(f"  launch failed: {e}")
        return False
    for _ in range(20):
        time.sleep(1)
        if cdp_alive():
            log("  relaunched — CDP up")
            return True
    log("  relaunched but CDP never came up")
    return False


def recycle(reason: str) -> None:
    log(f"RECYCLING: {reason}")
    # Close page targets at the BROWSER level first — this is the step a
    # reload cannot do, because a reload needs the blocked thread.
    for t in page_targets():
        try:
            with urllib.request.urlopen(f"{CDP}/json/close/{t['id']}", timeout=5):
                pass
            log(f"  closed target {t['id'][:12]}")
        except Exception as e:
            log(f"  close failed: {e}")
    time.sleep(2)
    if cdp_alive():
        kill_cdp_chrome()
        time.sleep(2)
    launch()


def check() -> str:
    if not cdp_alive():
        log("DEAD: CDP not answering")
        launch()
        return "relaunched"
    ok, detail = responsive()
    if ok:
        return f"healthy ({detail})"
    recycle(detail)
    return "recycled"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", type=int, default=60, help="seconds between checks (default 60; each probe attaches a CDP client, so do not hammer a live session)")
    ap.add_argument("--once", action="store_true", help="check once and exit")
    ap.add_argument("--port", type=int, help="CDP port (default 9224; also COPILOT2_PORT)")
    ap.add_argument("--url", help="page URL to keep open (also COPILOT2_URL)")
    ap.add_argument("--profile", help="chrome user-data-dir (also COPILOT2_PROFILE)")
    args = ap.parse_args()

    global CDP_PORT, CDP, URL, PROFILE, PROBE_SRC
    if args.port:
        CDP_PORT = args.port
        CDP = f"http://127.0.0.1:{CDP_PORT}"
        PROBE_SRC = PROBE_SRC.replace(f"127.0.0.1:9224", f"127.0.0.1:{CDP_PORT}")
    if args.url:
        URL = args.url
        PROBE_SRC = PROBE_SRC.replace('"8060" in x.url', f'"{URL.split("//")[-1].split("/")[0].split(":")[-1]}" in x.url')
    if args.profile:
        PROFILE = args.profile

    log(f"watchdog started — CDP {CDP}, profile {PROFILE}, every {args.interval}s")
    if args.once:
        log(check())
        return 0
    consecutive_recycles = 0
    # Heartbeat: a silent watchdog is indistinguishable from a dead one, so log
    # a healthy line periodically rather than only on failure. Quiet enough not
    # to bury the interesting lines.
    beat_every = max(1, 600 // max(args.interval, 1))
    n = 0
    while True:
        try:
            status = check()
            n += 1
            if status.startswith("healthy") and n % beat_every == 0:
                log(f"heartbeat — {status}")
            if status == "recycled":
                consecutive_recycles += 1
                # If recycling does not help, stop thrashing the owner's screen.
                if consecutive_recycles >= 3:
                    log("3 recycles in a row — backing off 5 min (something deeper is wrong)")
                    time.sleep(300)
                    consecutive_recycles = 0
            else:
                consecutive_recycles = 0
        except KeyboardInterrupt:
            log("stopped")
            return 0
        except Exception as e:
            log(f"watchdog error (continuing): {e}")
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
