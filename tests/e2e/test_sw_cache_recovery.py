#!/usr/bin/env python3
"""
Integration test: reproduce the stale service-worker cache hang, then prove the
version bump recovers it.

Replicates the 2026-06-26 prod incident. The SW caches /godot/* assets
cache-first, keyed on BUILD_VERSION (injected from game-version.json). That
version was frozen at v0.7.1849 while the deployed game advanced to v0.7.2047,
so the SW served a *stale cached WASM/PCK* (cache-first) against a *fresh
index.html* (network-first) -> version mismatch -> the game hung on "loading"
forever for every returning visitor and the installed PWA. The fix is bumping
the version so CACHE_NAME changes and the activate handler purges the old cache.

This drives the REAL public/sw.js against a tiny controllable "/godot/ build",
so a regression in the SW caching strategy OR the version mechanism fails here.

  Phase 1  baseline boots (SW caches v1)
  Phase 2  deploy a v2 build but DON'T bump the SW version -> reproduces the hang
  Phase 3  bump the SW version (the fix) -> SW purges + recovers

Run:  python tests/e2e/test_sw_cache_recovery.py
  or  pytest tests/e2e/test_sw_cache_recovery.py
"""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SW_SRC = (ROOT / "public" / "sw.js").read_text(encoding="utf-8")
assert "__BUILD_VERSION__" in SW_SRC, "sw.js lost its __BUILD_VERSION__ placeholder"

# Mutable server state. `build` = the version of the deployed /godot/ build;
# `sw` = the version injected into sw.js (what CACHE_NAME keys on).
STATE = {"build": "v1", "sw": "v1"}

INDEX_HTML = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  // index.html is network-first in sw.js, so it always reflects the CURRENT
  // build version. It then fetches the cache-first asset and compares: a
  // version mismatch is exactly the prod "stuck on loading" failure.
  window.__expected = "%EXPECTED%";
  window.__boot = "pending";
  fetch("/godot/app.bin", { cache: "no-store" })
    .then((r) => r.text())
    .then((t) => {
      window.__assetVersion = t.trim();
      window.__boot = (t.trim() === window.__expected) ? "ok" : "mismatch";
      // Mirror the real game: publish a scene on a successful boot. The parent
      // /play page reads this to know whether the game is stuck.
      if (window.__boot === "ok") window.gameState = { scene: "Title" };
    })
    .catch((e) => { window.__boot = "error:" + e; });
</script>OK</body></html>"""

# Parent page — mirrors the real /play: BaseLayout registers the SW and forces
# an update() check on load; UpdateOverlay auto-reloads if a new SW takes over
# while the game iframe is still stuck (the deadlock fix). The game runs in an
# iframe, exactly like prod.
PLAY_HTML = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  function onUpdate(src) {
    console.log("[play] update signal via " + src);
    setTimeout(function () {
      var f = document.querySelector("iframe"), booted = false;
      try { booted = !!(f && f.contentWindow && f.contentWindow.gameState && f.contentWindow.gameState.scene); } catch (e) {}
      console.log("[play] post-update check booted=" + booted);
      if (!booted && !sessionStorage.getItem("ab_autoapplied")) {
        sessionStorage.setItem("ab_autoapplied", "1");
        console.log("[play] auto-reloading");
        location.reload();
      }
    }, 800);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then(function (reg) {
      reg.update().catch(function () {});
      // Robust update detection: updatefound -> new worker activates, with a
      // pre-existing active worker (= a real update, not a first install).
      // Fires reliably across engines, unlike controllerchange suppression.
      reg.addEventListener("updatefound", function () {
        var updating = !!reg.active;
        var nw = reg.installing;
        if (!nw || !updating) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "activated") onUpdate("updatefound");
        });
      });
    });
    // Backup signal (works on Chromium/WebKit). The once-guard keeps it from
    // double-firing with updatefound.
    var hadController = !!navigator.serviceWorker.controller;
    var firstChange = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!hadController && !firstChange) { firstChange = true; return; }
      onUpdate("controllerchange");
    });
  }
</script>
<iframe id="game" src="/godot/index.html" style="width:320px;height:200px;border:0"></iframe>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, body: str, ctype: str):
        b = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        # max-age=0 mirrors prod sw.js headers; the SW (not HTTP cache) is the
        # thing under test.
        self.send_header("Cache-Control", "no-cache, max-age=0, must-revalidate")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/sw.js":
            self._send(SW_SRC.replace("__BUILD_VERSION__", STATE["sw"]), "application/javascript")
        elif p in ("/play", "/play/"):
            self._send(PLAY_HTML, "text/html")
        elif p in ("/godot/", "/godot/index.html"):
            self._send(INDEX_HTML.replace("%EXPECTED%", STATE["build"]), "text/html")
        elif p == "/godot/app.bin":
            # Cache-first in sw.js. Content = the build version at serve time;
            # a stale SW returns the OLD cached body instead of this.
            self._send(STATE["build"], "application/octet-stream")
        elif p == "/":
            self._send("<!doctype html><html><body>root</body></html>", "text/html")
        else:
            self.send_response(404)
            self.end_headers()


ENGINES = ["chromium", "firefox", "webkit"]  # webkit == the Safari / iOS engine


def run_scenario(pw, engine):
    """Run the 3-phase scenario on one browser engine. Returns a list of
    (name, passed, detail) tuples."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/godot/index.html"
    results = []
    try:
        if True:
            browser = getattr(pw, engine).launch()
            page = browser.new_context().new_page()

            def boot():
                page.goto(url, wait_until="load")
                page.wait_for_function("window.__boot !== 'pending'", timeout=15000)
                return page.evaluate("window.__boot")

            def sw_ready():
                page.evaluate("navigator.serviceWorker.ready.then(() => true)")

            # Phase 1 — baseline. First load registers the SW; second load runs
            # through it and caches the v1 asset.
            STATE.update(build="v1", sw="v1")
            boot()
            sw_ready()
            b1 = boot()
            results.append(("phase1_baseline_boots", b1 == "ok", b1))

            # Phase 2 — deploy a v2 build but leave the SW version frozen (the
            # exact prod bug). Fresh index.html (v2) + stale cached asset (v1).
            STATE.update(build="v2")  # sw stays "v1"
            b2 = boot()
            results.append(("phase2_stale_sw_reproduces_hang", b2 == "mismatch", b2))

            # Phase 3 — bump the SW version (the fix). The new SW installs,
            # skipWaiting + activate purges the v1 cache, and a reload boots
            # fresh. Recovery legitimately takes a load-cycle for the new worker
            # to take control — assert it recovers within a few loads.
            STATE.update(sw="v2")

            def diag():
                return page.evaluate(
                    """async () => {
                      const ks = await caches.keys();
                      const reg = await navigator.serviceWorker.getRegistration();
                      return {
                        caches: ks,
                        controller: navigator.serviceWorker.controller ? 'yes' : 'no',
                        installing: reg && reg.installing ? reg.installing.state : null,
                        waiting: reg && reg.waiting ? reg.waiting.state : null,
                        active: reg && reg.active ? reg.active.state : null,
                      };
                    }"""
                )

            recovered, used, last = False, 0, None
            for i in range(5):
                used = i + 1
                # Mirror prod's visibilitychange handler: explicitly poll for an
                # SW update, then reload.
                try:
                    page.evaluate("navigator.serviceWorker.getRegistration().then(r => r && r.update())")
                except Exception:
                    pass
                last = boot()
                sw_ready()
                d = diag()
                print(f"    [phase3 load {used}] boot={last} caches={d['caches']} "
                      f"ctrl={d['controller']} active={d['active']} waiting={d['waiting']}")
                if last == "ok":
                    recovered = True
                    break
            results.append((f"phase3_version_bump_recovers (in {used} load(s))", recovered, last))

            browser.close()
    finally:
        httpd.shutdown()
    return results


def run_autoupgrade(pw, engine):
    """End-to-end 'mock version upgrade': mirror the real /play (parent page +
    game iframe) and prove the app SELF-recovers on a version bump with NO
    manual reload — exercising the actual fixes (reg.update on load +
    UpdateOverlay auto-reload when the game is stuck)."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    play = f"http://127.0.0.1:{port}/play/"
    results = []
    try:
        browser = getattr(pw, engine).launch()
        page = browser.new_context().new_page()
        clogs = []
        page.on("console", lambda m: clogs.append(m.text))

        def booted():
            try:
                return bool(page.evaluate(
                    "() => { const f=document.querySelector('iframe');"
                    " try { return !!(f&&f.contentWindow&&f.contentWindow.gameState&&f.contentWindow.gameState.scene); }"
                    " catch(e){ return false; } }"
                ))
            except Exception:
                return False  # mid-navigation / reload

        def wait_booted(ms):
            waited = 0
            while waited < ms:
                if booted():
                    return True
                page.wait_for_timeout(300)
                waited += 300
            return False

        def sw_ready():
            try:
                page.evaluate("navigator.serviceWorker.ready.then(() => true)")
            except Exception:
                pass

        # Phase 1 — baseline: load /play, prime the SW cache (reload so the SW
        # controls the iframe), game boots.
        STATE.update(build="v1", sw="v1")
        page.goto(play, wait_until="load"); sw_ready()
        page.goto(play, wait_until="load"); sw_ready()
        b1 = wait_booted(8000)
        results.append(("autoupgrade_phase1_baseline_boots", b1, b1))

        # Phase 2 — deploy a new game build but DON'T bump the SW version: the
        # iframe gets a fresh index against a stale cached asset -> stuck.
        STATE.update(build="v2")
        page.goto(play, wait_until="load"); sw_ready()
        stuck = not wait_booted(4000)
        results.append(("autoupgrade_phase2_stale_reproduces_hang", stuck, "stuck" if stuck else "booted"))

        # Phase 3 — bump the SW version (the deploy). Do NOT reload manually;
        # the app's own logic must self-recover.
        STATE.update(sw="v2")
        try:
            page.evaluate("navigator.serviceWorker.getRegistration().then(r => r && r.update())")
        except Exception:
            pass
        recovered = wait_booted(15000)  # survives the auto-reload
        results.append(("autoupgrade_phase3_AUTO_recovers_no_manual_reload", recovered, recovered))
        if not recovered:
            play_logs = [l for l in clogs if "[play]" in l]
            print(f"    [{engine} autoupgrade FAIL] parent logs: {play_logs}")

        browser.close()
    finally:
        httpd.shutdown()
    return results


def run_all():
    """Run both scenarios on every engine. Uninstalled engines are skipped
    (reported, not failed) so the test still runs wherever it lands."""
    out = {}
    with sync_playwright() as pw:
        for engine in ENGINES:
            STATE.update(build="v1", sw="v1")  # reset between engines
            try:
                out[engine] = ("ran", run_scenario(pw, engine) + run_autoupgrade(pw, engine))
            except Exception as e:
                txt = str(e)
                kind = "skip" if ("Executable doesn't exist" in txt or "playwright install" in txt) else "error"
                out[engine] = (kind, txt.splitlines()[0] if txt else repr(e))
    return out


def _report(out):
    print("\n=== SW stale-cache recovery — cross-browser auto-update confirmation ===")
    overall_ok, any_ran = True, False
    for engine in ENGINES:
        status, payload = out.get(engine, ("missing", None))
        if status != "ran":
            print(f"\n{engine}: {status.upper()} — {payload}")
            overall_ok = overall_ok and status != "error"
            continue
        any_ran = True
        results = payload
        eng_ok = all(ok for _, ok, _ in results)
        overall_ok = overall_ok and eng_ok
        label = "  (Safari / iOS engine)" if engine == "webkit" else ""
        print(f"\n{engine}{label}: {'PASS' if eng_ok else 'FAIL'}")
        for name, ok, detail in results:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}  (boot={detail!r})")
    print("\n=== OVERALL:", "PASS" if (overall_ok and any_ran) else "FAIL", "===")
    return overall_ok and any_ran


def test_sw_cache_recovery():
    out = run_all()
    _report(out)
    ran = [e for e in ENGINES if out.get(e, (None,))[0] == "ran"]
    assert ran, "no browser engines available (run: playwright install)"
    failed = [e for e in ran if not all(o for _, o, _ in out[e][1])]
    assert not failed, f"auto-update FAILED on: {failed}"


if __name__ == "__main__":
    import sys
    sys.exit(0 if _report(run_all()) else 1)
