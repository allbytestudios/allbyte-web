"""Test the Godot game embed page."""


def test_godot_container_present(page, base_url):
    """Play page has the Godot embed container."""
    page.goto(f"{base_url}/play/", wait_until="domcontentloaded")
    container = page.locator(".godot-container")
    container.wait_for(state="visible")


def test_godot_canvas_element(page, base_url):
    """The Godot canvas element exists in the DOM."""
    page.goto(f"{base_url}/play/", wait_until="domcontentloaded")
    canvas = page.locator("#godot-canvas")
    assert canvas.count() == 1, "Expected exactly one #godot-canvas element"


def test_shared_array_buffer_available(page, base_url):
    """SharedArrayBuffer is available (requires COEP/COOP headers)."""
    page.goto(f"{base_url}/play/", wait_until="domcontentloaded")
    has_sab = page.evaluate("typeof SharedArrayBuffer !== 'undefined'")
    assert has_sab, "SharedArrayBuffer not available — check COEP/COOP headers"
