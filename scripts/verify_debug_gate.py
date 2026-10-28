#!/usr/bin/env python
"""Acceptance check for the single-build, debug-gated content model.

Spec: Arc, CON_CLAUDE_APP_WEBSITE_DEBUG_GATED_SELECTOR.md (owner canon 2026-10-27).

The model: ONE artifact. `debug` decides CONTENT SCOPE, because the game's
GlobalWorld.allows_episode_two() returns its `_debug_authorized`. Authorization is
PRESENCE-BASED and read once at boot, so omitting the query is NOT revocation —
a leftover cookie silently grants Episode Two.

WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT

  Overworld.pck is the observable proxy for Episode Two scope: ordinary
  production must never request it, debug-scoped boots prefetch it. That is a
  network fact checkable from outside the game, and it is the half that
  regresses silently.

  "Production+debug crosses FrontRoad" is NOT checked here. Crossing means
  actually playing to that exit, which is the autoplay harness's job. This is
  the gate check; the harness run is the gameplay check. Neither substitutes
  for the other.

  Debug forwarding is ADMIN-GATED by design (unchanged by this work), so an
  anonymous run cannot exercise the positive production+debug case — the
  wrapper correctly refuses. Case B asserts that refusal, which is a real
  check. The positive case needs an authenticated session; this script never
  handles a token.

    npm run verify:debug-gate -- --base https://allbyte.studio
"""
import argparse
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

DEBUG_COOKIE = "debug"

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print("  %s  %s" % ("PASS" if ok else "FAIL", name))
    if detail:
        print("        %s" % detail)


def boot(browser, base, path, settle_ms, seed_cookie=False):
    """Load a /play/ URL and report what the page asked the network for."""
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    if seed_cookie:
        # A leftover grant from an earlier debug session. Path "/" is the
        # broadest case; the wrapper must revoke it from /play/.
        origin = urlparse(base)
        ctx.add_cookies([{
            "name": DEBUG_COOKIE, "value": "1",
            "domain": origin.hostname, "path": "/",
        }])
    page = ctx.new_page()
    requested = []
    page.on("request", lambda r: requested.append(r.url))

    page.goto(base + path, wait_until="commit")
    page.wait_for_timeout(settle_ms)

    try:
        iframe_src = page.evaluate(
            "() => { const f = document.querySelector('iframe.game-frame');"
            "        return f ? f.getAttribute('src') : null; }"
        )
    except Exception:  # noqa: BLE001
        iframe_src = None

    cookie = next(
        (c["value"] for c in ctx.cookies()
         if c["name"] == DEBUG_COOKIE and c.get("value")),
        None,
    )
    ctx.close()
    # SUBSTRING, not endswith: the engine fetches these cache-busted
    # (index.wasm?v=<hash>, Overworld.pck?v=<hash>), so an endswith match is a
    # guaranteed false negative. This exact mistake made an earlier probe report
    # "engine never booted" against a build that was booting fine.
    return {
        "overworld": [u for u in requested if "Overworld.pck" in u],
        "engine": [u for u in requested if "index.wasm" in u],
        "iframe_src": iframe_src,
        "cookie": cookie,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://allbyte.studio")
    ap.add_argument("--settle", type=int, default=25000,
                    help="ms to let the boot settle before judging")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    print("debug-gate acceptance — %s\n" % base)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        print("A. Ordinary production  (/play/?v=alpha)")
        r = boot(browser, base, "/play/?v=alpha", args.settle)
        record("engine boots", bool(r["engine"]),
               "" if r["engine"] else "no index.wasm requested — the build never started, so the rest proves nothing")
        record("Overworld.pck is NEVER requested", not r["overworld"],
               ("requested %dx: %s" % (len(r["overworld"]), r["overworld"][0])) if r["overworld"] else "")
        record("iframe src carries no debug",
               bool(r["iframe_src"]) and "debug=" not in (r["iframe_src"] or ""),
               ("src=%s" % r["iframe_src"][:90]) if r["iframe_src"] else "no game iframe found")
        record("no debug cookie after load", r["cookie"] is None,
               ("cookie=%s" % r["cookie"]) if r["cookie"] else "")

        print("\nB. Production+debug, anonymous  (/play/?v=alpha-debug&debug=1)")
        r = boot(browser, base, "/play/?v=alpha-debug&debug=1", args.settle)
        record("anonymous visitor is NOT granted debug",
               bool(r["iframe_src"]) and "debug=" not in (r["iframe_src"] or ""),
               ("src=%s" % r["iframe_src"][:90]) if r["iframe_src"] else "no game iframe found")
        record("and therefore never fetches Overworld.pck", not r["overworld"],
               ("requested: %s" % r["overworld"][0]) if r["overworld"] else "")

        print("\nC. Revocation  (stale debug cookie, then /play/?v=alpha)")
        r = boot(browser, base, "/play/?v=alpha", args.settle, seed_cookie=True)
        record("stale debug cookie is CLEARED", r["cookie"] is None,
               ("cookie survived with value=%s — Episode Two silently unlocked" % r["cookie"]) if r["cookie"] else "")
        record("Overworld.pck still never requested", not r["overworld"],
               ("requested %dx — scope leaked through the cookie" % len(r["overworld"])) if r["overworld"] else "")

        browser.close()

    failed = [r for r in results if not r[1]]
    print("\n%d/%d checks passed" % (len(results) - len(failed), len(results)))
    if failed:
        print("\nFAILED:")
        for name, _, detail in failed:
            print("  - %s%s" % (name, (" (%s)" % detail) if detail else ""))
        return 1
    print("\nGate behaves per spec. Gameplay crossing (FrontRoad) is the harness's check, not this one.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
