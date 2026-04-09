"""Test responsive layout at different viewport sizes."""
import pytest


VIEWPORTS = [
    (1280, 960, "desktop"),
    (768, 1024, "tablet"),
    (375, 812, "mobile"),
]


@pytest.mark.parametrize("width,height,name", VIEWPORTS, ids=[v[2] for v in VIEWPORTS])
def test_index_renders_at_viewport(page, base_url, width, height, name):
    """Landing page renders without errors at each viewport size."""
    page.set_viewport_size({"width": width, "height": height})
    resp = page.goto(f"{base_url}/", wait_until="domcontentloaded")
    assert resp.status == 200

    # Check for JS errors
    errors = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.wait_for_timeout(1000)
    assert not errors, f"JS errors at {name} ({width}x{height}): {errors}"


@pytest.mark.parametrize("width,height,name", VIEWPORTS, ids=[v[2] for v in VIEWPORTS])
def test_subscribe_renders_at_viewport(page, base_url, width, height, name):
    """Subscribe page tier cards render at each viewport size."""
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base_url}/subscribe/", wait_until="domcontentloaded")
    cards = page.locator(".tier-card")
    cards.first.wait_for(state="visible")
    assert cards.count() == 3
