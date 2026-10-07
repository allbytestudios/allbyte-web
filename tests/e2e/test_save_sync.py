"""Browser adapter tests against a same-origin simulated game.

These verify actual browser chooser/download behavior and the host protocol.
They are NOT exported-Godot acceptance. The full game round trip remains a
release gate documented in docs/APP_SAVE_IMPORT_EXPORT_IMPLEMENTATION.md.
Run against the local Astro dev server: pytest tests/e2e/test_save_sync.py -v
"""
import json
from pathlib import Path


GAME = """<!doctype html><button id="import" onclick="parent.allbyteRequestImport()">Import</button>
<button id="export" onclick="parent.allbyteRequestExport()">Export</button>
<script>
window.snapshot = {saves:{slot_1:JSON.stringify({timestamp:1,value:'original'})},options:'{}',keymapping:'{}'};
window.send = data => parent.postMessage({protocolVersion:2,sessionId:'adapter-test',...data}, location.origin);
window.finish = ok => {
  if (ok) snapshot.saves = {...snapshot.saves,...window.pending.saves};
  send({type:'allbyte:load-complete',requestId:pending.requestId,ok,
    reason:ok?'':'storage_write_failed',acceptedSlots:ok?[1]:[],rejectedSlots:[],snapshot});
};
addEventListener('message', e => {
  if (e.source !== parent || e.origin !== location.origin) return;
  if (e.data.type === 'allbyte:request-saves') send({type:'allbyte:all-saves',requestId:e.data.requestId,...snapshot});
  if (e.data.type === 'allbyte:load-saves') {
    window.pending = e.data;
    send({type:'allbyte:load-pending',requestId:e.data.requestId,status:'awaiting_confirmation'});
  }
});
async function boot() {
  if (!parent.__saves_test) return setTimeout(boot, 20);
  const {auth} = await parent.eval("import('/src/lib/auth.svelte.ts')");
  auth.currentUser = null;
  send({type:'allbyte:ready',maxSaveSlots:12,saveCapabilities:{correlatedRequests:true,atomicImport:true,importConfirmation:true}});
}
boot();
</script>"""


def enter_play_mode(page, base_url):
    version = json.loads(Path(__file__).resolve().parents[2].joinpath("src/data/game-version.json").read_text())["version"]
    page.add_init_script("localStorage.setItem('ab_download_acked', %s)" % json.dumps(version))
    page.route("**/godot/**", lambda route: route.fulfill(status=200, content_type="text/html", body=GAME))
    page.goto(f"{base_url}/play/?scenario=__savesync", wait_until="domcontentloaded")
    page.wait_for_function("() => window.__saves_test?.isGameReady() && window.__saves_test.getCurrent().saves.slot_1")
    return page.frame_locator(".game-frame")


def current(page):
    return page.evaluate("window.__saves_test.getCurrent()")


def test_bridge_negotiates_protocol_2(page, base_url):
    enter_play_mode(page, base_url)
    assert page.evaluate("window.__saves_test.getProtocolVersion()") == 2
    assert page.evaluate("window.__saves_test.getMaxSaveSlots()") == 12


def test_unrequested_snapshot_cannot_replace_mirror(page, base_url):
    frame = enter_play_mode(page, base_url)
    frame.locator("body").evaluate("() => send({type:'allbyte:all-saves',requestId:'unrequested',saves:{},options:'',keymapping:''})")
    assert "slot_1" in current(page)["saves"]


def test_export_downloads_fresh_snapshot(page, base_url):
    frame = enter_play_mode(page, base_url)
    frame.locator("body").evaluate("() => snapshot.saves.slot_1 = JSON.stringify({timestamp:2,value:'fresh'})")
    with page.expect_download() as event:
        frame.locator("#export").click()
    payload = json.loads(Path(event.value.path()).read_text())
    assert payload["version"] == 1
    assert json.loads(payload["saves"]["slot_1"])["value"] == "fresh"


def choose_file(page, frame, tmp_path):
    file = tmp_path / "saves.json"
    file.write_text(json.dumps({"version": 1, "saves": {"slot_1": json.dumps({"timestamp": 2, "value": "imported"})}, "options": '{"volume":0}'}))
    with page.expect_file_chooser() as chooser:
        frame.locator("#import").click()
    chooser.value.set_files(file)
    frame.locator("body").evaluate("() => new Promise(resolve => {const poll=()=>window.pending?resolve():setTimeout(poll,10);poll()})")


def test_import_requires_successful_game_ack(page, base_url, tmp_path):
    frame = enter_play_mode(page, base_url)
    choose_file(page, frame, tmp_path)
    assert json.loads(current(page)["saves"]["slot_1"])["value"] == "original"
    assert frame.locator("body").evaluate("() => pending.source") == "import"
    assert frame.locator("body").evaluate("() => pending.options === undefined")
    frame.locator("body").evaluate("() => finish(true)")
    page.wait_for_function("() => JSON.parse(window.__saves_test.getCurrent().saves.slot_1).value === 'imported'")


def test_failed_import_preserves_mirror(page, base_url, tmp_path):
    frame = enter_play_mode(page, base_url)
    choose_file(page, frame, tmp_path)
    frame.locator("body").evaluate("() => finish(false)")
    page.wait_for_function("() => window.__saves_test.getErrorMessage()?.includes('storage_write_failed')")
    assert json.loads(current(page)["saves"]["slot_1"])["value"] == "original"
