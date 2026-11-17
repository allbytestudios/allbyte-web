"""Username saves: host + real game + real server integration.

Drives the dev host (localhost:4321/play/, serving the local game export) with
two separate browser profiles. Game-side BUTTON presses are emulated by posting
the game's own protocol messages from inside the game iframe (same source and
origin, so the host's checks apply as they would to the real game). Everything
after that is real:
  - the host's network calls to the deployed API,
  - the game applying results to its save storage,
  - a real autosave from the game going through the host to the server.
The Save/Load page UI itself is Quinn's e2e (scenario list in the coord doc).

Run (dev server up, AWS admin creds for cleanup):
  python tests/e2e/handles_integration.py
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
SCENARIO = "church_pre_paladin"
created = []
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail and not ok else ""))


def api_get(handle):
    with urllib.request.urlopen(f"{API}/handles/{handle}", timeout=20) as r:
        return json.loads(r.read())


INIT = """
localStorage.setItem('ab_download_acked', %s);
window.__fromGame = [];
window.addEventListener('message', e => { if (e.data && typeof e.data.type === 'string') window.__fromGame.push(e.data); });
""" % json.dumps(VERSION)


def open_play(browser, query=""):
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.add_init_script(INIT)
    page.goto(f"{BASE}/play/{query}")
    return ctx, page


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


def to_host(page, msg):
    """Post as the game: from the game iframe, carrying its sessionId."""
    sid = ready(page)["sessionId"]
    page.frames[1].evaluate("m => window.parent.postMessage(m, '*')",
                            {**msg, "sessionId": sid, "protocolVersion": 2})


def result(page, request_id, timeout=60):
    js = ("() => (window.__saves_test?.sentMessages||[]).find(m => m.type==='allbyte:handle-result' && m.requestId===%s)"
          % json.dumps(request_id))
    return wait(page, js, timeout, f"handle-result {request_id}")


def game_storage(page):
    return page.frames[1].evaluate("() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('con_nesis_')).map(k => [k, localStorage.getItem(k).length]))")


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
    try:
        # ---------------------------------------------------- device 1
        ctx1, page1 = open_play(browser)
        r = ready(page1)
        check("game declares saveCapabilities.handles", (r.get("saveCapabilities") or {}).get("handles") is True, r)
        lists = wait(page1, "() => (window.__saves_test?.sentMessages||[]).find(m => m.type==='allbyte:handles')", 30)
        check("host sends the dropdown lists on ready", lists and lists.get("active") is None, lists)

        to_host(page1, {"type": "allbyte:handle-create", "requestId": "c1"})
        res = result(page1, "c1")
        handle = res.get("handle")
        if handle:
            created.append(handle)
        check("Generate returns a new four-word name with empty saves",
              res.get("ok") and len((handle or "").split("-")) == 4 and res.get("saves") == {}, res)
        check("host remembers it as active on the device",
              page1.evaluate("() => localStorage.getItem('ab_handle_active')") == handle)

        # Reload into a scenario: the host restores the username on boot and
        # the scenario's arrival autosave is a real game write under it.
        device_before = {k: v for k, v in game_storage(page1).items() if not k.startswith("con_nesis_h_")}
        page1.goto(f"{BASE}/play/?channel=alpha-debug&scenario={SCENARIO}&packs=Laria,Combat&debug=1")
        ready(page1)
        boot = result(page1, None, 90)
        check("boot restores the username (requestId null)", boot.get("ok") and boot.get("handle") == handle, boot)

        # The scenario import itself writes slot 99; the arrival autosave is
        # slot 0. Wait for the AUTOSAVE: it's the write playtesters rely on.
        try:
            changed = wait(page1, "() => (window.__fromGame||[]).find(m => m.type==='allbyte:save-changed' && m.slotId===0 && m.handle===%s)"
                           % json.dumps(handle), 180, "autosave (slot 0) under the username")
        except TimeoutError:
            seen = page1.evaluate("() => (window.__fromGame||[]).filter(m => m.type==='allbyte:save-changed').map(m => [m.slotId, m.handle])")
            check("game emits an AUTOSAVE (slot 0) carrying the username", False, f"save-changed seen: {seen}")
            raise
        check("game emits an AUTOSAVE (slot 0) carrying the username", changed.get("handle") == handle, changed)
        slot = "slot_0"

        server = None
        t0 = time.time()
        while time.time() - t0 < 30:
            server = api_get(handle)
            if slot in server.get("saves", {}):
                break
            time.sleep(2)
        check(f"the write reaches the server ({slot})", slot in (server or {}).get("saves", {}), server and list(server["saves"]))

        store = game_storage(page1)
        check("game keeps it under the username's own keys",
              any(k.startswith(f"con_nesis_h_{handle}_save_") for k in store), list(store))
        device_after = {k: v for k, v in store.items() if not k.startswith("con_nesis_h_")}
        untouched = all(device_after.get(k) == v for k, v in device_before.items() if "_save_" in k)
        check("device save slots untouched", untouched, (device_before, device_after))

        # ---------------------------------------------------- device 2
        ctx2, page2 = open_play(browser)
        ready(page2)
        typed = handle.replace("-", " ").upper()
        to_host(page2, {"type": "allbyte:handle-select", "requestId": "s1", "handle": typed})
        res2 = result(page2, "s1")
        check("typing the name on another device logs in", res2.get("ok") and res2.get("handle") == handle, res2)
        check("and brings its saves", slot in (res2.get("saves") or {}), res2.get("saves") and list(res2["saves"]))
        time.sleep(2)
        store2 = game_storage(page2)
        check("game on device 2 stores them under the username",
              f"con_nesis_h_{handle}_{slot.replace('slot_', 'save_')}" in store2, list(store2))
        check("device 2 remembers the name",
              handle in page2.evaluate("() => JSON.parse(localStorage.getItem('ab_handles')||'[]').map(e => e.h)"))

        to_host(page2, {"type": "allbyte:handle-select", "requestId": "s2", "handle": "black sparkling opaque dragon"})
        check("a name that isn't real is refused", result(page2, "s2").get("error") in ("invalid", "not_found"))

        to_host(page2, {"type": "allbyte:handle-clear", "requestId": "x1"})
        res3 = result(page2, "x1")
        check("Use device saves clears the username",
              res3.get("ok") and res3.get("handle") is None and page2.evaluate("() => localStorage.getItem('ab_handle_active')") is None, res3)
        ctx1.close(); ctx2.close()
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
