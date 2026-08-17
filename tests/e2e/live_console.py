#!/usr/bin/env python3
"""
live_console.py - read the LIVE site's browser console + drive the game, via Playwright.

A shared debugging harness for App and Arc: point it at a deployed channel (esp.
develop) and read exactly what the browser sees - every console line, page error,
and failed/HTML-fallback request - without needing a local build. Born from the
2026-07-25 combat-hang debug, where the console (PCK "MD5 ... does not match"
errors) was the thing that cracked it.

It loads either the real player path (/play/?channel=<ch>, download gate auto-acked)
or the raw channel build (/godot/<ch>/index.html), captures the console, and can
optionally drive the game through its TestBridge window hooks.

USAGE
  python tests/e2e/live_console.py                         # develop, /play path, 15s
  python tests/e2e/live_console.py --raw                   # raw /godot/develop/ build
  python tests/e2e/live_console.py --channel alpha
  python tests/e2e/live_console.py --grep "MD5|decrypt|error"   # filter console
  python tests/e2e/live_console.py --wait 25 --headed
  python tests/e2e/live_console.py --raw --drive "enter,menudump"   # drive via hooks
  python tests/e2e/live_console.py --raw --drive "menu:items,export"
  python tests/e2e/live_console.py --out report.json       # full JSON report

OPTIONS
  --channel <name>  alpha (prod) | alpha-debug (prod debug) (default: alpha-debug)
  --raw             load /godot/<channel>/index.html directly (no /play embed/gate)
  --base <url>      site origin (default: https://allbyte.studio)
  --url <url>       explicit URL, overrides --channel/--raw/--base
  --drive <steps>   comma list via real TestBridge hooks, each "name" or "name:arg":
                    enter | cancel | inject:<action> | encounter[:<id>] |
                    loadsave:<slot> | menu:<label> | menudump | export
  --wait <s>        seconds to observe after load (default: 15)
  --grep <regex>    only print console lines matching this (case-insensitive)
  --headed          show the browser window
  --out <path>      also write a full JSON report (console + network + gameState)

CHANNEL NOTE: use --raw to debug a specific channel. /play?channel=<ch> is
tier-gated - an anonymous session falls back to the PUBLIC build, so
/play?channel=develop shows the public version, not develop. --raw loads
/godot/<channel>/index.html directly (no auth), which is the develop build.

Requires: playwright (pip install playwright && playwright install chromium).
Runs on host (App) or in the container (Arc) - swiftshader GL, no GPU needed.
"""
import argparse
import json
import re
import sys
from playwright.sync_api import sync_playwright


def asc(s):
    return str(s).encode("ascii", "replace").decode()


def build_url(a):
    if a.url:
        return a.url
    if a.raw:
        return f"{a.base}/godot/{a.channel}/index.html"
    return f"{a.base}/play/?channel={a.channel}"


def game_frame(page, raw):
    """The frame the game (and its window hooks) live in: the page itself for a raw
    build, or the Godot iframe inside /play/."""
    if raw:
        return page.main_frame
    for f in page.frames:
        if "/godot/" in (f.url or ""):
            return f
    return page.main_frame


# Real TestBridge hooks (per Arc, confirmed live). They are WRITE sentinels the
# game polls each frame - set window.<hook> = <value>, then poll a result var;
# `typeof` is 'undefined' until set, so never guard by existence, just assign.
# NOTE: do NOT touch window._testBridgeNode (removed, QB-039) - use published
# objects (_testBridge_lastCombatSnapshot / _testBridge_itemsGrid / _skillTreeGrid).
#
# --drive steps (comma list, each "name" or "name:arg"):
#   enter            -> _testPressEnter=1        (advance Title / dialogue / confirm)
#   cancel           -> _testPressCancel=1
#   inject:<action>  -> _testInjectAction="<action>"   (arbitrary ui_* action)
#   encounter[:<id>] -> _testEncounter=<id|0>   (fire the current scene's encounter)
#   loadsave:<slot>  -> _testLoadGame=<slot>     (load a staged save)
#   menu:<label>     -> _testMenuNavLabel="<label>", poll _testMenuNavResult (labels lowercased)
#   menudump         -> _testMenuNavDump=1, read _testMenuNavDumpResult (labels/graph)
#   export           -> _testExportCurrentSave=1, read _testExportedSave (live party/items)
def _set(gf, hook, val_js):
    return asc(gf.evaluate(f"() => {{ try {{ window.{hook} = {val_js}; return 'set {hook}={val_js}'; }} catch(e){{ return 'err:'+e; }} }}"))


def _read(gf, var, cap=400):
    v = gf.evaluate(f"() => {{ try {{ var v = window.{var}; return v==null?null:(typeof v==='string'?v:JSON.stringify(v)); }} catch(e){{ return 'err:'+e; }} }}")
    return (asc(v)[:cap] if v is not None else None)


def drive_step(gf, page, step):
    name, _, arg = step.partition(":")
    if name == "enter":       return _set(gf, "_testPressEnter", "1")
    if name == "cancel":      return _set(gf, "_testPressCancel", "1")
    if name == "inject":      return _set(gf, "_testInjectAction", json.dumps(arg))
    if name == "encounter":   return _set(gf, "_testEncounter", arg or "0")
    if name == "loadsave":    return _set(gf, "_testLoadGame", arg or "1")
    if name == "menu":
        _set(gf, "_testMenuNavLabel", json.dumps(arg)); page.wait_for_timeout(1500)
        return f"nav -> {_read(gf, '_testMenuNavResult')}"
    if name == "menudump":
        _set(gf, "_testMenuNavDump", "1"); page.wait_for_timeout(1500)
        return f"dump -> {_read(gf, '_testMenuNavDumpResult')}"
    if name == "export":
        _set(gf, "_testExportCurrentSave", "1"); page.wait_for_timeout(1500)
        n = gf.evaluate("() => (window._testExportedSave||'').length")
        return f"exported live save (len {n})"
    return "unknown step (see --drive docs)"


def main():
    ap = argparse.ArgumentParser(description="Read the live site console via Playwright.")
    ap.add_argument("--channel", default="alpha-debug")
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--base", default="https://allbyte.studio")
    ap.add_argument("--url", default="")
    ap.add_argument("--drive", default="")
    ap.add_argument("--wait", type=int, default=15)
    ap.add_argument("--grep", default="")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    url = build_url(a)
    grep = re.compile(a.grep, re.I) if a.grep else None
    console, failed, drove = [], [], []

    print(f"[live-console] loading {url}")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=not a.headed, args=["--use-gl=swiftshader"])
        page = b.new_context().new_page()
        page.on("console", lambda m: console.append((m.type, asc(m.text))))
        page.on("pageerror", lambda e: console.append(("pageerror", asc(e))))
        page.on("requestfailed", lambda r: failed.append((asc(r.url), asc(r.failure or ""))))
        # a /godot/ request that returns HTML is the SPA-fallback / missing-asset tell
        page.on("response", lambda r: failed.append((asc(r.url), f"HTTP {r.status} {r.headers.get('content-type','')}"))
                if r.status >= 400 or ("/godot/" in r.url and "text/html" in (r.headers.get("content-type", ""))
                                       and not r.url.rstrip("/").endswith("index.html")) else None)

        page.goto(url, wait_until="load", timeout=90000)

        # auto-ack the /play download gate so the iframe actually loads. The gate is
        # a Svelte island (client:load) that appears after hydration, so wait, then
        # click the first visible button matching the gate copy (a few retries).
        if not a.raw and not a.url:
            page.wait_for_timeout(3500)  # let the island hydrate
            gate_re = re.compile(r"continue|download|understand|play|MB|start", re.I)
            clicked = False
            for _ in range(4):
                for btn in page.get_by_role("button").all():
                    try:
                        txt = (btn.inner_text(timeout=1500) or "").strip()
                        if gate_re.search(txt) and btn.is_visible():
                            btn.click(timeout=4000)
                            print(f"[live-console] clicked download gate: {asc(txt)[:40]!r}")
                            clicked = True
                            break
                    except Exception:
                        continue
                if clicked:
                    break
                page.wait_for_timeout(2000)
            if not clicked:
                print("[live-console] no download-gate button matched (already acked, or embed changed)")

        page.wait_for_timeout(a.wait * 1000)

        gf = game_frame(page, a.raw)
        try:
            state = gf.evaluate("""() => ({
                ready: (window.gameState && window.gameState.ready) ?? null,
                version: (window.gameState && window.gameState.version) ?? null,
                scene: (window.gameState && window.gameState.scene) ?? null,
                inBattle: (window.gameState && window.gameState.inBattle) ?? null,
                menuShown: (window.gameState && window.gameState.menuShown) ?? null,
            })""")
        except Exception as e:
            state = {"error": asc(e)}

        for step in [s.strip() for s in a.drive.split(",") if s.strip()]:
            try:
                drove.append((step, drive_step(gf, page, step)))
                page.wait_for_timeout(2000)
            except Exception as e:
                drove.append((step, f"eval-failed: {asc(e)}"))

        if drove:
            state_after = {}
            try:
                state_after = gf.evaluate("() => ({inBattle:(window.gameState||{}).inBattle ?? null, menuShown:(window.gameState||{}).menuShown ?? null, scene:(window.gameState||{}).scene ?? null})")
            except Exception:
                pass
            state["after_drive"] = state_after

        b.close()

    # ---- report ----
    print("\n=== gameState ===")
    for k, v in state.items():
        print(f"  {k}: {v}")

    lines = console if not grep else [(t, x) for (t, x) in console if grep.search(x)]
    errs = [(t, x) for (t, x) in lines if t in ("error", "pageerror")]
    print(f"\n=== console: {len(console)} total, {len(errs)} errors"
          + (f", {len(lines)} match /{a.grep}/" if grep else "") + " ===")
    for t, x in (lines[:60]):
        print(f"  [{t}] {x[:200]}")
    if len(lines) > 60:
        print(f"  (+{len(lines) - 60} more)")

    if failed:
        seen, uniq = set(), []
        for u, why in failed:
            k = (u.split("?")[0], why)
            if k in seen:
                continue
            seen.add(k)
            uniq.append((u, why))
        print(f"\n=== failed / HTML-fallback requests ({len(uniq)} unique) ===")
        for u, why in uniq[:25]:
            print(f"  {why}  {u[:110]}")

    if drove:
        print("\n=== drive steps ===")
        for step, res in drove:
            print(f"  {step}: {res}")

    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump({"url": url, "gameState": state, "console": console,
                       "failed": failed, "drove": drove}, f, indent=2)
        print(f"\n[live-console] full report -> {a.out}")

    # non-zero exit if there were errors, so it can gate CI / scripts
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
