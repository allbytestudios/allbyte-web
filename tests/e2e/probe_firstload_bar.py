"""Visual review of the first-load progress bar (Arc's v0.7.2049 ask).

Determinism problem: index.js is a blocking script that sits *above* the bar-
wiring IIFE. Throttled, the parser stalls before the IIFE runs (no listener);
unthrottled, the real engine resolves and removes the shell before we can inject.
Fix: stub index.js with a fake Engine that reports no missing features and a
startGame() that never resolves — so the wiring IIFE runs (listeners attached)
and the shell stays mounted. Then inject the exact `allbyte:download-progress`
event the app posts, plus exercise the engine onProgress path, and read the bar.

Run with the dev server up:  python tests/e2e/probe_firstload_bar.py
"""
import os
import time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:4321")
OUT = os.path.join(os.path.dirname(__file__), "test_results")
os.makedirs(OUT, exist_ok=True)

MB = 1048576
APP_TOTAL = 105 * MB                  # what GodotEmbed/BilateralLayout post today
TITLE_TOTAL = 36879516 + 24929996     # ~59 MiB, the to-Title total Arc's text assumes

ENGINE_STUB = """
window.Engine = function(cfg){ this.cfg = cfg; };
window.Engine.getMissingFeatures = function(){ return []; };
window.Engine.prototype.startGame = function(opts){
  window.__onProgress = opts && opts.onProgress;
  return new Promise(function(){});   // never resolves -> shell stays up
};
window.Engine.prototype.installServiceWorker = function(){ return Promise.resolve(); };
"""

SEQUENCES = {
    "app105": [(8 * MB, APP_TOTAL), (37 * MB, APP_TOTAL), (59 * MB, APP_TOTAL)],
    "title59": [(8 * MB, TITLE_TOTAL), (37 * MB, TITLE_TOTAL), (59 * MB, TITLE_TOTAL)],
}


def read_bar(page):
    return page.evaluate("""() => {
      const wrap = document.getElementById('chronicles-progress-wrap');
      const fill = document.getElementById('chronicles-progress-bar-fill');
      const text = document.getElementById('chronicles-progress-text');
      if (!wrap) return null;
      return { display: getComputedStyle(wrap).display,
               width: fill ? fill.style.width : '?',
               text: text ? text.textContent : '?' };
    }""")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844},
                                  device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        # Replace the real engine loader with a stub that keeps the shell up.
        page.route("**/index.js*", lambda route: route.fulfill(
            status=200, content_type="application/javascript", body=ENGINE_STUB))

        print(f"[probe] loading {BASE}/godot/index.html with stubbed engine")
        page.goto(f"{BASE}/godot/index.html", wait_until="load")
        time.sleep(0.5)
        print("[probe] shell present:", read_bar(page) is not None)

        for name, seq in SEQUENCES.items():
            print(f"\n--- allbyte:download-progress event, total={'105MB' if name=='app105' else '59MB'} ---")
            for i, (b, t) in enumerate(seq):
                page.evaluate(
                    """([b, t]) => window.dispatchEvent(new CustomEvent(
                         'allbyte:download-progress', {detail:{bytesDownloaded:b, expectedBytes:t}}))""",
                    [b, t])
                time.sleep(0.3)
                print(f"  inject {b//MB:>3}/{t//MB:>3} MB -> {read_bar(page)}")
                page.screenshot(path=os.path.join(OUT, f"bar_{name}_{i}.png"))
            # reset the never-regress guard for the next sequence by reloading
            page.goto(f"{BASE}/godot/index.html", wait_until="load")
            time.sleep(0.4)

        # Engine onProgress path (the index.pck phase).
        print("\n--- engine onProgress(current,total) path ---")
        for cur, tot in [(5 * MB, 24 * MB), (24 * MB, 24 * MB)]:
            page.evaluate("([c,t]) => window.__onProgress && window.__onProgress(c,t)", [cur, tot])
            time.sleep(0.3)
            print(f"  onProgress {cur//MB}/{tot//MB} MB -> {read_bar(page)}")
        page.screenshot(path=os.path.join(OUT, "bar_onprogress.png"))

        ctx.close()
        browser.close()
        print(f"\n[probe] screenshots in {OUT}")


if __name__ == "__main__":
    main()
