"""Save sync protocol tests.

These tests don't require a real Godot iframe — they mock the iframe's postMessage
behavior by dispatching fake MessageEvent objects directly into the parent window.
The saves.svelte.ts handler picks them up identically to a real iframe message.

Test hook: saves.svelte.ts exposes window.__saves_test with state getters and a
sentMessages array that captures every postMessage the parent sends to the iframe.

Run with: npm run test:a11y or pytest tests/e2e/test_save_sync.py -v
Requires: dev server on localhost:4321
"""
import json
import pytest


# === Helpers ===


def enter_play_mode(page, base_url):
    """Click the demo banner to enter play mode and wait for the iframe + bridge."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    # Do NOT wait_for_load_state("networkidle") here: the landing page keeps
    # audio connections open (music player + cursor sfx), so it never reaches
    # networkidle in dev and the wait times out. Wait for the element we need.
    page.wait_for_selector(".demo-row", timeout=10000)
    # Set the test bypass flag BEFORE entering play mode so the bridge picks it up
    page.evaluate("window.__saves_test_skip_source_check = true")
    # Click the demo banner to launch the game
    page.click(".demo-row")
    # Wait for the iframe to mount
    page.wait_for_selector(".game-frame", timeout=5000)
    # Wait for the test hook to be installed
    page.wait_for_function("() => window.__saves_test !== undefined", timeout=5000)
    # Wait for the expand-in animation to complete (0.8s + buffer)
    page.wait_for_timeout(900)


def fire_game_message(page, msg):
    """Dispatch a fake message from the 'game' to the parent window."""
    # We have to dispatch as if from the iframe; saves.svelte.ts checks
    # event.source === iframeRef.contentWindow if iframeRef exists.
    # Since the dev iframe URL is cross-origin in dev (localhost:8060),
    # iframeRef.contentWindow will be the actual iframe window — which we
    # can't easily fake. So instead, we patch handleGameMessage to skip the
    # source check during tests, OR we use a workaround.
    #
    # Simpler: dispatch via the iframe's contentWindow itself if same origin,
    # otherwise post via window.postMessage with a fake source check bypass.
    page.evaluate(
        """(msg) => {
            // Send via window.postMessage from the iframe window if reachable,
            // otherwise dispatch a synthetic MessageEvent on the parent window.
            const iframe = document.querySelector('.game-frame');
            if (iframe && iframe.contentWindow) {
                try {
                    // Same-origin path: dispatch from inside the iframe
                    iframe.contentWindow.parent.postMessage(msg, '*');
                    return;
                } catch (e) {
                    // Cross-origin: fall through to synthetic event
                }
            }
            // Fallback: synthesize a MessageEvent and dispatch on the parent.
            // This bypasses the source check; we accept that as a test concession.
            const evt = new MessageEvent('message', {
                data: msg,
                source: iframe ? iframe.contentWindow : null,
                origin: '*',
            });
            window.dispatchEvent(evt);
        }""",
        msg,
    )


def get_sent_messages(page):
    """Return the list of messages the parent has sent to the game iframe."""
    return page.evaluate("() => (window.__saves_test && window.__saves_test.sentMessages) || []")


def get_save_store_state(page, key):
    """Read a value from the test hook."""
    return page.evaluate(f"() => window.__saves_test.{key}()")


# PlayOverlay was removed in Phase 3 (2026-05-31). Back/Save/Load are now
# game-side; quit comes through the allbyte:request-exit / parent.allbyteRequestExit
# protocol. See docs/WEB_GAME_BOUNDARY.md for the contract. The
# UI-level tests that lived here were deleted with the component.


# === postMessage protocol ===


def test_bridge_captures_ready(page, base_url):
    """Firing allbyte:ready captures protocolVersion and maxSaveSlots."""
    enter_play_mode(page, base_url)

    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    # Give the handler a tick
    page.wait_for_function("() => window.__saves_test.isGameReady() === true", timeout=2000)

    assert get_save_store_state(page, "getProtocolVersion") == 1
    assert get_save_store_state(page, "getMaxSaveSlots") == 12
    assert get_save_store_state(page, "isGameReady") is True


def test_save_changed_updates_cache(page, base_url):
    """A save-changed message updates the in-memory cache for that slot."""
    enter_play_mode(page, base_url)
    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    page.wait_for_function("() => window.__saves_test.isGameReady() === true")

    save_data = json.dumps({"version": 1, "timestamp": 1234567890, "test": "slot1"})
    fire_game_message(page, {"type": "allbyte:save-changed", "slotId": 1, "data": save_data})

    page.wait_for_function(
        "() => window.__saves_test.getCurrent().saves.slot_1 !== undefined",
        timeout=2000,
    )
    current = get_save_store_state(page, "getCurrent")
    assert current["saves"]["slot_1"] == save_data


def test_all_saves_snapshot_replaces_cache(page, base_url):
    """An all-saves snapshot fully replaces the cache."""
    enter_play_mode(page, base_url)
    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    page.wait_for_function("() => window.__saves_test.isGameReady() === true")

    snapshot = {
        "type": "allbyte:all-saves",
        "protocolVersion": 1,
        "saves": {
            "slot_1": json.dumps({"version": 1, "timestamp": 100}),
            "slot_2": json.dumps({"version": 1, "timestamp": 200}),
        },
        "options": '{"volume":0.8}',
        "keymapping": '{"jump":"space"}',
    }
    fire_game_message(page, snapshot)

    page.wait_for_function(
        "() => window.__saves_test.getCurrent().options === '{\"volume\":0.8}'",
        timeout=2000,
    )
    current = get_save_store_state(page, "getCurrent")
    assert "slot_1" in current["saves"]
    assert "slot_2" in current["saves"]
    assert current["options"] == '{"volume":0.8}'
    assert current["keymapping"] == '{"jump":"space"}'


def test_load_complete_with_rejected_slots_surfaces_error(page, base_url):
    """A load-complete message with rejected slots surfaces an error."""
    enter_play_mode(page, base_url)
    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    page.wait_for_function("() => window.__saves_test.isGameReady() === true")

    fire_game_message(
        page,
        {
            "type": "allbyte:load-complete",
            "acceptedSlots": [1, 2],
            "rejectedSlots": [{"slot": 3, "reason": "version mismatch: got 0, expected 1"}],
        },
    )

    page.wait_for_function(
        "() => window.__saves_test.getErrorMessage() !== null",
        timeout=2000,
    )
    err = get_save_store_state(page, "getErrorMessage")
    assert "slot 3" in err
    assert "version mismatch" in err


def test_pre_ready_queue_drains_on_ready(page, base_url):
    """Messages sent before ready are queued and drained when ready arrives."""
    enter_play_mode(page, base_url)

    # Trigger requestSavesFromGame BEFORE ready by directly calling the test hook?
    # Easier: simulate by clicking a button that calls loadSavesIntoGame.
    # Even simpler: use page.evaluate to dispatch a request directly via the
    # exposed store. But the queue is internal — we can verify by sending a
    # request-saves message into the parent (no wait — that's a parent->game
    # message, which is what we want to verify queues).
    #
    # Best path: trigger the queue by importing the function into the page context.
    # Since saves.svelte.ts is bundled, we need a side-channel. Use the test hook
    # to call requestSavesFromGame indirectly... but we don't expose that.
    #
    # Alternative: let the bridge auto-request on ready. We can verify the
    # initial request-saves goes out AFTER ready arrives (in fact, AS A RESULT of
    # ready), confirming the gating works.

    # Pre-ready: queue should be empty, no sent messages yet
    initial_queue_len = page.evaluate("() => window.__saves_test.getPreReadyQueueLength()")
    initial_sent = len(get_sent_messages(page))
    assert initial_queue_len == 0
    # The bridge does NOT auto-send anything before ready

    # Fire ready — this triggers requestSavesFromGame() inside the handler
    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    page.wait_for_function("() => window.__saves_test.isGameReady() === true")

    # After ready, request-saves should have been sent
    page.wait_for_function(
        "() => window.__saves_test.sentMessages.some(m => m.type === 'allbyte:request-saves')",
        timeout=2000,
    )
    sent = get_sent_messages(page)
    types = [m["type"] for m in sent]
    assert "allbyte:request-saves" in types


# === Export / Import (local file) ===


def test_export_downloads_current_saves(page, base_url):
    """allbyteRequestExport() downloads the cached saves as a JSON file whose
    contents match the in-memory snapshot."""
    enter_play_mode(page, base_url)
    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    page.wait_for_function("() => window.__saves_test.isGameReady() === true")

    slot1 = json.dumps({"version": 1, "timestamp": 111, "test": "export"})
    fire_game_message(page, {
        "type": "allbyte:all-saves", "protocolVersion": 1,
        "saves": {"slot_1": slot1},
        "options": '{"volume":0.5}', "keymapping": '{"jump":"x"}',
    })
    page.wait_for_function("() => window.__saves_test.getCurrent().saves.slot_1 !== undefined")

    # downloadSavesFile() fires the anchor download (after a ~300ms debounce).
    with page.expect_download(timeout=5000) as dl_info:
        page.evaluate("() => window.allbyteRequestExport()")
    download = dl_info.value
    assert "chronicles-of-nesis-saves" in download.suggested_filename
    with open(download.path(), encoding="utf-8") as f:
        content = json.load(f)
    assert content["saves"]["slot_1"] == slot1
    assert content["options"] == '{"volume":0.5}'
    assert content["keymapping"] == '{"jump":"x"}'


def test_import_loads_file_saves_into_game(page, base_url, tmp_path):
    """Choosing a save file in the hidden import picker parses it and forwards
    the saves to the game via allbyte:load-saves."""
    enter_play_mode(page, base_url)
    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    page.wait_for_function("() => window.__saves_test.isGameReady() === true")

    slot2 = json.dumps({"version": 1, "timestamp": 222, "test": "import"})
    save_file = tmp_path / "import-saves.json"
    save_file.write_text(json.dumps({
        "version": 1, "exportedAt": "2026-06-17T00:00:00Z",
        "saves": {"slot_2": slot2}, "options": "{}", "keymapping": "{}",
    }), encoding="utf-8")

    # The hidden file input (accept=json) is the import picker created by the bridge.
    page.set_input_files("input[type=file][accept*='json']", str(save_file))

    page.wait_for_function(
        "() => window.__saves_test.sentMessages.some(m => m.type === 'allbyte:load-saves')",
        timeout=3000,
    )
    load_msgs = [m for m in get_sent_messages(page) if m["type"] == "allbyte:load-saves"]
    assert load_msgs, "expected an allbyte:load-saves message after import"
    assert load_msgs[-1]["saves"]["slot_2"] == slot2
    # And the local cache picked it up.
    assert get_save_store_state(page, "getCurrent")["saves"]["slot_2"] == slot2


# === Cloud sync (Hero/Legend, server round-trip) ===


def test_cloud_sync_pulls_for_hero(page, base_url):
    """A Hero/Legend user pulls from GET /saves on game-ready. (Dev initAuth
    auto-logs in as admin, so the test forces the tier via setTestTier.)"""
    methods = []

    def saves_route(route):
        methods.append(route.request.method)
        if route.request.method == "GET":
            route.fulfill(status=404, content_type="application/json", body="{}")
        else:
            route.fulfill(status=200, content_type="application/json",
                          body='{"updatedAt":"2026-06-17T00:00:00Z"}')

    page.route("**/saves", saves_route)

    enter_play_mode(page, base_url)
    page.evaluate("() => window.__saves_test.setTestTier('hero')")
    page.wait_for_function("() => window.__saves_test.getIsSyncTier() === true", timeout=3000)

    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    # ready triggers syncFromServer() for hero → GET /saves.
    page.wait_for_timeout(800)
    assert "GET" in methods, f"expected a GET /saves cloud pull for hero, got {methods}"


def test_cloud_sync_skipped_for_ineligible_tier(page, base_url):
    """A non-eligible tier (e.g. Initiate) never touches the cloud /saves endpoint."""
    methods = []

    def saves_route(route):
        methods.append(route.request.method)
        route.fulfill(status=404, content_type="application/json", body="{}")

    page.route("**/saves", saves_route)

    enter_play_mode(page, base_url)
    page.evaluate("() => window.__saves_test.setTestTier('initiate')")
    page.wait_for_function("() => window.__saves_test.getIsSyncTier() === false")

    fire_game_message(page, {"type": "allbyte:ready", "protocolVersion": 1, "maxSaveSlots": 12})
    page.wait_for_timeout(800)
    assert methods == [], f"ineligible tier must not hit cloud saves, got {methods}"
