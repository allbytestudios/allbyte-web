"""Username saves: the e2e scenarios that need more than one browser.

Covers scenarios 2 (another device), 7 (two tabs) and 8 (offline) from the
test plan in APP_CLAUDE_USERNAME_SAVES.md. Quinn covers the single-browser
user flows. Runs on the dev host (localhost:4321/play/) against the local game
export, with the deployed API. Cleans up its usernames.

  python tests/e2e/handles_e2e_multi.py
"""
import json
import sys
import time
import urllib.request

import boto3
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4321"
API = "https://1f379pb6ek.execute-api.us-east-1.amazonaws.com"
VERSION = json.load(open("src/data/game-version.json"))["version"]
SCENARIO = "/play/?channel=alpha-debug&scenario=church_pre_paladin&packs=Laria,Combat&debug=1"
created, results = [], []

INIT = """
localStorage.setItem('ab_download_acked', %s);
window.__fromGame = [];
window.addEventListener('message', e => { if (e.data && typeof e.data.type === 'string') window.__fromGame.push(e.data); });
""" % json.dumps(VERSION)


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail and not ok else ""))


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def wait(page, js, timeout=180, label=""):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = page.evaluate(js)
            if v:
                return v
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError(label or js)


def ready(page):
    return wait(page, "() => (window.__fromGame||[]).find(m => m.type==='allbyte:ready')", label="game ready")


def game(page):
    return page.frames[1]


def to_host(page, msg):
    sid = ready(page)["sessionId"]
    game(page).evaluate("m => window.parent.postMessage(m, '*')", {**msg, "sessionId": sid, "protocolVersion": 2})


def result(page, request_id, timeout=60):
    return wait(page, "() => (window.__saves_test?.sentMessages||[]).find(m => m.type==='allbyte:handle-result' && m.requestId===%s)"
                % json.dumps(request_id), timeout, f"handle-result {request_id}")


def new_page(ctx, path="/play/"):
    page = ctx.new_page()
    page.add_init_script(INIT)
    page.goto(BASE + path)
    ready(page)
    return page


def make_handle(page, rid):
    to_host(page, {"type": "allbyte:handle-create", "requestId": rid})
    h = result(page, rid)["handle"]
    created.append(h)
    return h


def autosave(page, handle, timeout=180):
    return wait(page, "() => (window.__fromGame||[]).find(m => m.type==='allbyte:save-changed' && m.slotId===0 && m.handle===%s)"
                % json.dumps(handle), timeout, "arrival autosave")


def scene(page):
    return game(page).evaluate("() => window.gameState && (window.gameState.scene || window.gameState.currentScene)")


def server_saves(handle):
    return api("GET", f"/handles/{handle}")


def until(fn, timeout=60, step=2):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
    try:
        # ------------------------------------------------ 2. another device
        print("\n-- scenario 2: another device")
        dev1 = browser.new_context(viewport={"width": 1280, "height": 800})
        p1 = new_page(dev1)
        handle = make_handle(p1, "c")
        p1.goto(BASE + SCENARIO)
        ready(p1)
        auto = autosave(p1, handle)
        scene1 = wait(p1, "() => { const f = document.querySelector('iframe'); const g = f && f.contentWindow.gameState; return g && g.scene && g.scene !== 'Title' && g.scene !== 'MainLoader' ? g.scene : null }", 120, "in-game scene")
        # _testLoadGame only takes slots 1-12, so file device 1's real autosave
        # as manual slot 2 too, as if the player had saved there.
        cur = until(lambda: (lambda s: s if "slot_0" in s["saves"] else None)(server_saves(handle)), 30)
        check("device 1's autosave is on the server", cur is not None)
        api("PUT", f"/handles/{handle}/saves", {"saves": {**cur["saves"], "slot_2": auto["data"]}, "expectedRevision": cur["revision"]})

        dev2 = browser.new_context(viewport={"width": 1280, "height": 800})
        p2 = new_page(dev2, "/play/?channel=alpha-debug&debug=1")
        to_host(p2, {"type": "allbyte:handle-select", "requestId": "s", "handle": "  " + handle.replace("-", " ").title() + " "})
        got = result(p2, "s")
        check("device 2 logs in by typing the name", got.get("ok") and got.get("handle") == handle, got)
        check("device 2 gets slot 2 and the autosave", {"slot_0", "slot_2"} <= set(got.get("saves") or {}), list(got.get("saves") or {}))
        time.sleep(2)
        game(p2).evaluate("() => { window._testLoadGame = 2 }")
        scene2 = wait(p2, "() => { const f = document.querySelector('iframe'); const g = f && f.contentWindow.gameState; return g && g.scene && g.scene !== 'Title' && g.scene !== 'MainLoader' ? g.scene : null }", 120, "device 2 in-game scene")
        check(f"slot 2 loads on device 2 into the same scene ({scene1})", scene2 == scene1, f"device1={scene1} device2={scene2}")
        dev2.close()

        # ------------------------------------------------ 7. two tabs
        print("\n-- scenario 7: two tabs, same username")
        tab_a = new_page(dev1)  # same profile = shared localStorage, like real tabs
        tab_b = new_page(dev1)
        base = server_saves(handle)
        to_host(tab_a, {"type": "allbyte:handle-select", "requestId": "a", "handle": handle})
        to_host(tab_b, {"type": "allbyte:handle-select", "requestId": "b", "handle": handle})
        result(tab_a, "a"); result(tab_b, "b")
        # Both tabs now hold the same revision. Each writes a different slot
        # at the same moment, so one upload must hit the revision conflict.
        to_host(tab_a, {"type": "allbyte:save-changed", "slotId": 3, "data": "tab-a-slot-3", "handle": handle})
        to_host(tab_b, {"type": "allbyte:save-changed", "slotId": 4, "data": "tab-b-slot-4", "handle": handle})
        final = until(lambda: (lambda s: s if s["saves"].get("slot_3") == "tab-a-slot-3" and s["saves"].get("slot_4") == "tab-b-slot-4" else None)(server_saves(handle)), 60)
        check("both tabs' saves survive on the server", final is not None, server_saves(handle)["saves"].keys())
        check("earlier slots are kept", final and {"slot_0", "slot_2"} <= set(final["saves"]), final and list(final["saves"]))
        # Tabs in one profile share the upload queue, so they never conflict.
        check("tabs share one upload queue (no conflict needed)", final and final["revision"] >= base["revision"] + 1,
              final and (base["revision"], final["revision"]))
        tab_a.close(); tab_b.close()

        # Two separate devices on the same username, writing at once: separate
        # queues, same starting revision, so one upload MUST hit the conflict.
        print("\n-- scenario 7b: two devices writing at the same moment")
        dx = browser.new_context(viewport={"width": 1280, "height": 800})
        dy = browser.new_context(viewport={"width": 1280, "height": 800})
        px, py = new_page(dx), new_page(dy)
        to_host(px, {"type": "allbyte:handle-select", "requestId": "x", "handle": handle})
        to_host(py, {"type": "allbyte:handle-select", "requestId": "y", "handle": handle})
        result(px, "x"); result(py, "y")
        base = server_saves(handle)
        to_host(px, {"type": "allbyte:save-changed", "slotId": 5, "data": "device-x-slot-5", "handle": handle})
        to_host(py, {"type": "allbyte:save-changed", "slotId": 6, "data": "device-y-slot-6", "handle": handle})
        final = until(lambda: (lambda s: s if s["saves"].get("slot_5") == "device-x-slot-5" and s["saves"].get("slot_6") == "device-y-slot-6" else None)(server_saves(handle)), 60)
        check("both devices' saves survive", final is not None, list(server_saves(handle)["saves"]))
        check("the second writer rebased after the conflict (revision +2)", final and final["revision"] == base["revision"] + 2,
              final and (base["revision"], final["revision"]))
        check("nothing earlier was lost", final and {"slot_0", "slot_2", "slot_3", "slot_4"} <= set(final["saves"]), final and list(final["saves"]))
        dx.close(); dy.close()

        # ------------------------------------------------ 8. offline
        print("\n-- scenario 8: save while the server is unreachable")
        off = browser.new_context(viewport={"width": 1280, "height": 800})
        p3 = new_page(off)
        h2 = make_handle(p3, "c2")
        p3.goto(BASE + SCENARIO)
        ready(p3)
        result(p3, None, 90)  # boot restore must finish before we cut the server off
        off.route("**/1f379pb6ek.execute-api.us-east-1.amazonaws.com/**", lambda r: r.abort())
        auto2 = autosave(p3, h2)
        time.sleep(4)  # past the 2s upload debounce; the upload fails
        pending = p3.evaluate("() => JSON.parse(localStorage.getItem('ab_handle_pending')||'{}')")
        check("the save is queued on the device while offline", "slot_0" in (pending.get(h2) or {}), pending)
        check("and has not reached the server", "slot_0" not in server_saves(h2)["saves"])
        queued = p3.evaluate("() => JSON.parse(localStorage.getItem('ab_handle_pending')||'{}')")[h2]["slot_0"]
        emitted = p3.evaluate("() => (window.__fromGame||[]).filter(m => m.type==='allbyte:save-changed' && m.slotId===0).length")
        print(f"   (autosaves while offline: {emitted}; first == queued: {queued == auto2['data']})")
        off.unroute("**/1f379pb6ek.execute-api.us-east-1.amazonaws.com/**")
        p3.goto(BASE + "/play/")  # next visit, no scenario (so no new autosave): start() uploads the queue
        ready(p3)
        landed = until(lambda: server_saves(h2)["saves"].get("slot_0") == queued or None, 60)
        check("back online, the latest queued save reaches the server", landed,
              (len(server_saves(h2)["saves"].get("slot_0") or ""), len(queued)))
        check("and the queue is empty", until(lambda: p3.evaluate("() => !Object.keys(JSON.parse(localStorage.getItem('ab_handle_pending')||'{}')).length"), 20))
        off.close(); dev1.close()
    finally:
        browser.close()
        table = boto3.resource("dynamodb", region_name="us-east-1").Table("allbyte-studio-handle-saves")
        s3 = boto3.client("s3", region_name="us-east-1")
        for h in created:
            table.delete_item(Key={"pk": f"h#{h}"})
            for obj in s3.list_objects_v2(Bucket="allbyte-studio-handle-saves", Prefix=f"h/{h}/").get("Contents", []):
                s3.delete_object(Bucket="allbyte-studio-handle-saves", Key=obj["Key"])

passed = sum(ok for _, ok in results)
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
