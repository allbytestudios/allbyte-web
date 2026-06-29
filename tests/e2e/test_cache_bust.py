"""Proves the versioned-fetch (`?v=<build>`) cache-bust prevents a stale-binary
serve — Arc's root-cause fix for the mismatched-pair "out of bounds memory
access" crash.

Isolation: keep the service worker the SAME (no cache-name bump) and only change
the BUILD version. Then the cache-bust is the ONLY thing that can refresh the
binaries:
  - VERSIONED   (engine fetches `index.wasm?v=<build>`): a new build-version is a
    new URL → cache-miss → fresh fetch → the client runs the NEW binaries.
  - UNVERSIONED (engine fetches bare `index.wasm`): same URL → cache-hit → the
    client runs the STALE old binaries (the bug Arc's patch fixes).

Runs the REAL public/sw.js (version-injected) and a mini "engine" that fetches
index.wasm + index.pck and reports which build it loaded, on chromium / firefox
/ webkit.

Run:  python tests/e2e/test_cache_bust.py   (no dev server needed)
"""
import http.server
import os
import socketserver
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SW_SRC = os.path.join(ROOT, "public", "sw.js")
SW_JS = open(SW_SRC, encoding="utf-8").read().replace("__BUILD_VERSION__", "cachebust-sw")

# Mutable server state (one process; the test mutates between page loads).
STATE = {"build": "v1", "versioned": True}

REG_PAGE = """<!doctype html><meta charset=utf-8><body><script>
navigator.serviceWorker.register('/sw.js', {scope:'/'})
  .then(r => navigator.serviceWorker.ready)
  .then(() => { window.__swready = true; });
</script></body>"""

# The mini "engine": fetch the two binaries (with ?v=<build> iff versioned),
# read their version tag, and report. coherent == both binaries same build.
def game_page(build, versioned):
    q = f"?v={build}" if versioned else ""
    return f"""<!doctype html><meta charset=utf-8><body><script>
(async () => {{
  try {{
    const w = (await (await fetch('index.wasm{q}')).text()).trim();
    const p = (await (await fetch('index.pck{q}')).text()).trim();
    window.__loaded = {{ wasm: w, pck: p, coherent: w === p }};
  }} catch (e) {{ window.__loaded = {{ error: String(e) }}; }}
}})();
</script></body>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype, sw=False):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if sw:
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Service-Worker-Allowed", "/")
        else:
            # HTML/version-pointer: must revalidate (mirrors prod). Binaries are
            # versioned by URL, so they can be immutable — but for the test we
            # just let the SW own caching; no-cache keeps the HTTP layer honest.
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(REG_PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/sw.js":
            self._send(SW_JS.encode(), "application/javascript", sw=True)
        elif path == "/godot/index.html":
            self._send(game_page(STATE["build"], STATE["versioned"]).encode(), "text/html; charset=utf-8")
        elif path == "/godot/index.wasm":
            self._send(STATE["build"].encode(), "application/wasm")
        elif path == "/godot/index.pck":
            self._send(STATE["build"].encode(), "binary/octet-stream")
        else:
            self.send_response(404)
            self.end_headers()


def run_variant(p, engine, versioned):
    """Returns (loaded_build_after_deploy, coherent) for one engine + mode."""
    STATE["versioned"] = versioned
    STATE["build"] = "v1"
    browser = getattr(p, engine).launch()
    ctx = browser.new_context()  # fresh = clean SW + cache
    page = ctx.new_page()
    base = run_variant.base

    # 1) register the SW
    page.goto(base, wait_until="domcontentloaded")
    page.wait_for_function("window.__swready === true", timeout=15000)

    # 2) load the game at v1 — SW caches the v1 binaries
    page.goto(f"{base}godot/index.html", wait_until="domcontentloaded")
    page.wait_for_function("window.__loaded", timeout=15000)
    first = page.evaluate("window.__loaded")

    # 3) DEPLOY a new build — SW version UNCHANGED, so only ?v= can refresh
    STATE["build"] = "v2"

    # 4) reload the game; read which build it actually ran
    page.goto(f"{base}godot/index.html", wait_until="domcontentloaded")
    page.wait_for_function("window.__loaded", timeout=15000)
    after = page.evaluate("window.__loaded")

    ctx.close()
    browser.close()
    return first, after


def main():
    import sys
    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
        httpd.allow_reuse_address = True
        port = httpd.server_address[1]
        run_variant.base = f"http://127.0.0.1:{port}/"
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        print(f"[test] server on {run_variant.base}")

        results = {}
        with sync_playwright() as p:
            for engine in ("chromium", "firefox", "webkit"):
                try:
                    # sanity: engine launches
                    getattr(p, engine).launch().close()
                except Exception as e:
                    print(f"[{engine}] unavailable: {e}")
                    continue
                v_first, v_after = run_variant(p, engine, True)
                u_first, u_after = run_variant(p, engine, False)
                # PASS: versioned client refreshed to v2; unversioned stayed stale at v1
                ver_ok = v_after.get("wasm") == "v2" and v_after.get("pck") == "v2" and v_after.get("coherent")
                unver_stale = u_after.get("wasm") == "v1"  # demonstrates the bug the bust fixes
                results[engine] = ver_ok and unver_stale
                print(f"\n[{engine}]")
                print(f"  VERSIONED  (?v=): after deploy ran build {v_after.get('wasm')}/{v_after.get('pck')} "
                      f"coherent={v_after.get('coherent')}  -> {'FRESH ✓' if ver_ok else 'STALE/MIX ✗'}")
                print(f"  UNVERSIONED     : after deploy ran build {u_after.get('wasm')}/{u_after.get('pck')} "
                      f"-> {'stale v1 (bug the ?v= fixes) ✓ shown' if unver_stale else 'unexpected ✗'}")
                print(f"  => {'PASS' if results[engine] else 'FAIL'}")

        httpd.shutdown()
        tested = list(results)
        print(f"\n[test] engines passed: {[e for e in results if results[e]]} of {tested}")
        if not tested:
            print("[test] FAIL — no engines available")
            return 1
        return 0 if all(results.values()) else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
