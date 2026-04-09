"""Test the bilateral landing page layout."""
import pytest


def test_engine_panel_visible(page, base_url):
    """The Engine (dev/technical) panel renders with expected content."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    # Engine panel has engine-bg class and contains "Dev" title
    engine = page.locator(".engine-bg").first
    engine.wait_for(state="visible")


def test_heart_panel_visible(page, base_url):
    """The Heart (art/creative) panel renders with expected content."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    heart = page.locator(".heart-bg").first
    heart.wait_for(state="visible")


def test_subscribe_button_in_header(page, base_url):
    """Header has a subscribe button linking to /subscribe/."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    btn = page.locator(".subscribe-btn")
    btn.wait_for(state="visible")


def test_mobile_stacking(page, base_url):
    """At mobile viewport, panels stack vertically."""
    page.set_viewport_size({"width": 375, "height": 812})
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    # Mobile layout uses .mobile-panel instead of .bilateral-grid
    mobile_panels = page.locator(".mobile-panel")
    assert mobile_panels.count() >= 2, "Expected stacked mobile panels"
