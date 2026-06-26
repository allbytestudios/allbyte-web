"""Proves the gzip-encoded WASM survives the service-worker cache round-trip.

We pre-compress index.wasm for transport (~35MB → ~9MB) and serve it with
Content-Encoding: gzip. The risk: a network Response with a transfer
Content-Encoding has an already-decoded body but still advertises the encoding
+ compressed length. If the real public/sw.js caches that verbatim, replaying
it from cache makes the browser re-decode plain bytes → corrupt WASM (black
screen). sw.js's toCacheable() must strip those headers.

This test runs the REAL public/sw.js (version-injected) against a local server
that serves /godot/* gzip-encoded, and asserts a /godot/* asset fetched twice
(network, then cache) is byte-identical to the original plaintext on BOTH
reads. It also checks WebAssembly.instantiateStreaming succeeds on a gzip-served
wasm wrapped in the shim's clean-header synthetic Response (and that the OLD
verbatim-header wrapping fails — proving the fix matters).

Run:  python tests/e2e/test_wasm_gzip_cache.py   (no dev server needed)
"""
import gzip
import http.server
import os
import socketserver
import threading
import hashlib

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SW_SRC = os.path.join(ROOT, "public", "sw.js")

# A known, incompressible-ish but reproducible asset payload (256 KB).
ASSET = bytes((i * 31 + 7) % 256 for i in range(256 * 1024))
ASSET_SHA = hashlib.sha256(ASSET).hexdigest()
ASSET_GZ = gzip.compress(ASSET)

# A minimal *valid* empty WASM module (8-byte header). instantiateStreaming
# succeeds on this. Served gzip-encoded to exercise the shim/instantiate path.
WASM = bytes([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00])
WASM_GZ = gzip.compress(WASM)

SW_JS = open(SW_SRC, encoding="utf-8").read().replace("__BUILD_VERSION__", "test-gzip-1")

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>gzip sw test</title></head>
<body><script>
window.__log = [];
const log = (m) => { window.__log.push(m); };
async function run() {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  // Ensure the active worker controls this page.
  if (!navigator.serviceWorker.controller) {
    await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  }

  const sha = async (buf) => {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join('');
  };

  // --- Risk 1: SW cache replay of a gzip /godot/* asset ---
  const r1 = await fetch('/godot/asset.bin', { cache: 'no-store' });
  const b1 = await r1.arrayBuffer();
  window.__sha_net = await sha(b1);
  // Second fetch should come from the SW cache (cache-first).
  const r2 = await fetch('/godot/asset.bin');
  const b2 = await r2.arrayBuffer();
  window.__sha_cache = await sha(b2);

  // --- Risk 2: shim synthetic Response over gzip wasm ---
  // Clean headers (the proposed shim fix): instantiate should succeed.
  try {
    const resp = await fetch('/godot/index.wasm');
    const buf = await resp.arrayBuffer();
    const clean = new Headers(); clean.set('content-type', 'application/wasm');
    const synthetic = new Response(buf, { status: resp.status, headers: clean });
    await WebAssembly.instantiateStreaming(synthetic);
    window.__instantiate_clean = 'ok';
  } catch (e) { window.__instantiate_clean = 'FAIL: ' + e.message; }

  // Verbatim headers (the CURRENT deployed shim): copies content-encoding:gzip
  // + compressed length onto a plaintext body. Does it still instantiate?
  try {
    const resp = await fetch('/godot/index.wasm');
    const buf = await resp.arrayBuffer();
    const synthetic = new Response(buf, { status: resp.status, headers: resp.headers });
    await WebAssembly.instantiateStreaming(synthetic);
    window.__instantiate_verbatim = 'ok';
  } catch (e) { window.__instantiate_verbatim = 'FAIL: ' + e.message; }

  // --- Does the OLD (pre-strip) sw.js corrupt? Cache a gzip response VERBATIM
  // (exactly what the old cacheFirst did: cache.put(req, response.clone())) and
  // read it back. If the bytes differ from original, the old sw.js corrupts on
  // replay → the gzip WASM must NOT go live before the strip-capable sw.js.
  try {
    const c = await caches.open('verbatim-replay-test');
    const r = await fetch('/godot/asset.bin', { cache: 'no-store' });
    await c.put('/godot/asset.bin', r.clone());
    const hit = await c.match('/godot/asset.bin');
    const hb = await hit.arrayBuffer();
    window.__sha_verbatim_cache = await sha(hb);
  } catch (e) { window.__sha_verbatim_cache = 'FAIL: ' + e.message; }

  window.__done = true;
}
run().catch(e => { window.__error = String(e); window.__done = true; });
</script></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype, *, gz=False, sw=False):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        # SW must be served fresh; allow it to control the scope.
        if sw:
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/" or path == "/index.html":
            self._send(PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/sw.js":
            self._send(SW_JS.encode(), "application/javascript", sw=True)
        elif path == "/godot/asset.bin":
            self._send(ASSET_GZ, "application/octet-stream", gz=True)
        elif path == "/godot/index.wasm":
            self._send(WASM_GZ, "application/wasm", gz=True)
        else:
            self.send_response(404)
            self.end_headers()


def main():
    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
        httpd.allow_reuse_address = True
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        base = f"http://127.0.0.1:{port}/"
        print(f"[test] server on {base}")

        results = {}
        with sync_playwright() as p:
            for engine in ("chromium", "firefox", "webkit"):
                launcher = getattr(p, engine)
                try:
                    browser = launcher.launch()
                except Exception as e:
                    print(f"[{engine}] launch unavailable: {e}")
                    continue
                ctx = browser.new_context()
                page = ctx.new_page()
                page.goto(base, wait_until="domcontentloaded")
                page.wait_for_function("window.__done === true", timeout=20000)
                data = page.evaluate("""() => ({
                  err: window.__error || null,
                  net: window.__sha_net, cache: window.__sha_cache,
                  inst: window.__instantiate_clean,
                  verbatim: window.__instantiate_verbatim,
                  vcache: window.__sha_verbatim_cache, log: window.__log,
                })""")
                ok_cache = data["net"] == ASSET_SHA and data["cache"] == ASSET_SHA
                ok_inst = data["inst"] == "ok"
                results[engine] = ok_cache and ok_inst and not data["err"]
                print(f"\n[{engine}] error={data['err']}")
                print(f"  net   sha == original: {data['net'] == ASSET_SHA}")
                print(f"  cache sha == original: {data['cache'] == ASSET_SHA}  (the replay gotcha)")
                print(f"  instantiateStreaming (clean headers):    {data['inst']}")
                print(f"  instantiateStreaming (verbatim headers): {data['verbatim']}")
                vc = "intact (old sw.js safe)" if data["vcache"] == ASSET_SHA else f"CORRUPT -> {data['vcache'][:24]} (old sw.js BREAKS gzip; deploy order matters)"
                print(f"  verbatim cache replay: {vc}")
                print(f"  => {'PASS' if results[engine] else 'FAIL'}")
                ctx.close()
                browser.close()

        httpd.shutdown()
        tested = list(results)
        passed = [e for e in results if results[e]]
        print(f"\n[test] ASSET_SHA={ASSET_SHA[:16]}…  engines passed: {passed} of {tested}")
        if not tested:
            print("[test] FAIL — no engines available")
            return 1
        return 0 if all(results.values()) else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
