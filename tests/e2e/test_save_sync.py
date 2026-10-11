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
const sessionId = crypto.randomUUID();
window.send = data => parent.postMessage({protocolVersion:2,sessionId,...data}, location.origin);
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
    page.route("**/godot/**", lambda route: route.fulfill(status=200, content_type="text/html", headers={"Cross-Origin-Embedder-Policy": "require-corp"}, body=GAME))
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


def test_native_return_restores_real_iframe_canvas_focus(page, base_url):
    frame = enter_play_mode(page, base_url)
    frame.locator("body").evaluate("""() => {
      const canvas=document.createElement('canvas'); canvas.id='canvas'; canvas.tabIndex=0;
      document.body.appendChild(canvas);
    }""")
    result = page.evaluate("""async () => {
      const {restoreGameFocus}=await import('/src/lib/native-file-prompt.ts');
      const frame=document.querySelector('.game-frame');
      document.body.tabIndex=-1; document.body.focus();
      const restored=restoreGameFocus(document,frame);
      const focused=frame.contentDocument.activeElement.id==='canvas' && frame.contentDocument.hasFocus();
      const input=document.createElement('input'); document.body.appendChild(input); input.focus();
      const protectedHost=!restoreGameFocus(document,frame) && document.activeElement===input;
      input.remove();
      return {restored,focused,protectedHost};
    }""")
    assert result == {"restored": True, "focused": True, "protectedHost": True}


def test_early_return_retries_focus_after_file_input_removal(page, base_url):
    enter_play_mode(page, base_url)
    result = page.evaluate("""async () => {
      const {NativeFilePrompt,restoreGameFocus}=await import('/src/lib/native-file-prompt.ts');
      const frame=document.querySelector('.game-frame');
      const canvas=frame.contentDocument.createElement('canvas');
      canvas.id='canvas'; canvas.tabIndex=0; frame.contentDocument.body.appendChild(canvas);
      document.body.tabIndex=-1; document.body.focus();
      const attempts=[], events=[]; let files=0, input;
      const prompt=new NativeFilePrompt(window,document,e=>{
        events.push(e);
        if(e.phase==='returned') attempts.push(restoreGameFocus(document,frame));
      },()=>{files++;},()=>attempts.push(restoreGameFocus(document,frame)));
      const create=document.createElement;
      try {
        document.createElement=function(tag,...args){
          const element=create.call(this,tag,...args);
          if(tag==='input') {
            input=element;
            element.showPicker=()=>{
              element.focus();
              window.dispatchEvent(new Event('blur'));
              window.dispatchEvent(new Event('focus'));
            };
          }
          return element;
        };
        prompt.open();
      } finally { document.createElement=create; }
      try {
        const transfer=new DataTransfer(); transfer.items.add(new File(['{}'],'save.json'));
        input.files=transfer.files; input.dispatchEvent(new Event('change'));
        return {attempts,files,returns:events.filter(e=>e.phase==='returned').length,
          removed:!input.isConnected,focused:frame.contentDocument.activeElement===canvas && frame.contentDocument.hasFocus()};
      } finally { prompt.destroy(); }
    }""")
    # Real DOM/focus, modeled chooser event ordering: not a Windows OS dialog test.
    assert result == {"attempts": [False, True], "files": 1, "returns": 1,
                      "removed": True, "focused": True}


def test_save_trace_correlates_import_without_payload_and_is_bounded(page, base_url, tmp_path):
    frame = enter_play_mode(page, base_url)
    choose_file(page, frame, tmp_path)
    frame.locator("body").evaluate("() => finish(false)")
    page.wait_for_function("() => window.__allbyteSaveTrace.read().some(e => e.event === 'request_matched' && e.type === 'allbyte:load-complete')")
    entries = page.evaluate("__allbyteSaveTrace.read()")
    events = [e["event"] for e in entries]
    for expected in ["import_invoked", "native_prompt", "input_removed", "focus_attempt", "file_selected", "backup_validated"]:
        assert expected in events
    native = [e for e in entries if e["event"] == "native_prompt"]
    assert len([e for e in native if e["phase"] == "returned"]) == 1
    assert native[0]["promptId"] == native[-1]["promptId"]
    sent = next(e for e in entries if e["event"] == "message_sent" and e["type"] == "allbyte:load-saves")
    ack = next(e for e in entries if e["event"] == "request_matched" and e["type"] == "allbyte:load-complete")
    assert sent["requestId"] == ack["requestId"]
    assert sent["sessionId"] == ack["sessionId"]
    assert sent["promptId"] == native[0]["promptId"]
    encoded = json.dumps(entries)
    assert '"slot_1"' not in encoded and '"imported"' not in encoded and 'saves.json' not in encoded
    result = page.evaluate("""() => {
      const copy=__allbyteSaveTrace.read(); copy[0].event='tampered';
      const isolated=__allbyteSaveTrace.read()[0].event!=='tampered';
      for(let i=0;i<270;i++) document.dispatchEvent(new Event('visibilitychange'));
      const entries=__allbyteSaveTrace.read();
      return {isolated,length:entries.length,ordered:entries.every((e,i)=>!i || e.sequence>entries[i-1].sequence)};
    }""")
    assert result == {"isolated": True, "length": 256, "ordered": True}
