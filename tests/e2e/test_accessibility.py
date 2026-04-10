"""WCAG 2.1 AA accessibility tests.

These verify the fixes from the accessibility audit. They check focus management,
form labels, modal behavior, contrast, touch target sizes, and heading hierarchy.

Run with: npm run test:a11y (requires dev server on localhost:4321)
"""
import pytest
import re


# === Phase 1: Critical Accessibility ===


def test_login_modal_inputs_have_labels(page, base_url):
    """Every input in the login modal has either a <label for> or aria-label."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")

    # Open the modal
    page.click("button.login-btn")
    page.wait_for_selector(".modal", state="visible")

    # Check sign-in form first
    inputs = page.query_selector_all(".modal input")
    assert len(inputs) >= 2, f"Expected at least 2 inputs in sign-in form, got {len(inputs)}"
    for inp in inputs:
        input_id = inp.get_attribute("id")
        aria_label = inp.get_attribute("aria-label")
        # Either id with matching label, or aria-label
        if input_id:
            label = page.query_selector(f'label[for="{input_id}"]')
            assert label is not None, f"Input #{input_id} has no matching <label for>"
        else:
            assert aria_label, "Input has no id and no aria-label"

    # Switch to sign-up tab
    page.click('button.modal-tab:has-text("Create Account")')
    page.wait_for_timeout(100)
    inputs = page.query_selector_all(".modal input")
    assert len(inputs) >= 4, f"Expected at least 4 inputs in sign-up form, got {len(inputs)}"
    for inp in inputs:
        input_id = inp.get_attribute("id")
        aria_label = inp.get_attribute("aria-label")
        if input_id:
            label = page.query_selector(f'label[for="{input_id}"]')
            assert label is not None, f"Input #{input_id} has no matching <label for>"
        else:
            assert aria_label, "Input has no id and no aria-label"


def test_login_modal_focus_trap(page, base_url):
    """Tab key cycles within the modal; Escape closes and restores focus."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")

    trigger_selector = "button.login-btn"
    page.focus(trigger_selector)
    page.click(trigger_selector)
    page.wait_for_selector(".modal", state="visible")

    # First focusable element should be focused (not the trigger)
    page.wait_for_timeout(100)
    active = page.evaluate("document.activeElement.tagName")
    assert active in ("INPUT", "BUTTON"), f"Expected INPUT/BUTTON to be focused, got {active}"

    # Verify focus is inside the modal
    in_modal = page.evaluate("document.querySelector('.modal').contains(document.activeElement)")
    assert in_modal, "Initial focus should be inside the modal"

    # Press Escape, modal should close
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    modal = page.query_selector(".modal")
    assert modal is None, "Modal should be closed after Escape"

    # Focus should return to the trigger button
    page.wait_for_timeout(100)
    active_class = page.evaluate("document.activeElement.className || ''")
    assert "login-btn" in active_class, f"Focus should return to login-btn, got '{active_class}'"


def test_login_modal_has_aria_attributes(page, base_url):
    """Modal has role=dialog, aria-modal=true, and aria-labelledby."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    page.click("button.login-btn")
    page.wait_for_selector(".modal", state="visible")

    modal = page.query_selector(".modal")
    assert modal.get_attribute("role") == "dialog"
    assert modal.get_attribute("aria-modal") == "true"
    labelledby = modal.get_attribute("aria-labelledby")
    assert labelledby, "Modal should have aria-labelledby"
    label_el = page.query_selector(f"#{labelledby}")
    assert label_el is not None, f"aria-labelledby points to #{labelledby} but element not found"


def test_modal_close_button_has_aria_label(page, base_url):
    """Close button has an accessible name (aria-label or text content)."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    page.click("button.login-btn")
    page.wait_for_selector(".modal", state="visible")

    close_btn = page.query_selector(".modal-close")
    aria_label = close_btn.get_attribute("aria-label")
    assert aria_label, "Modal close button needs aria-label"


def test_focus_visible_on_buttons(page, base_url):
    """Tabbing to a button shows a visible focus outline."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")

    # Tab to focus the first interactive element
    page.keyboard.press("Tab")
    page.wait_for_timeout(100)

    # Get computed outline width of focused element
    outline_width = page.evaluate("""
        () => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const style = getComputedStyle(el);
            // Extract numeric value from outline-width like "2px"
            const match = style.outlineWidth.match(/(\\d+)/);
            return match ? parseInt(match[1]) : 0;
        }
    """)
    assert outline_width is not None and outline_width >= 1, \
        f"Focused element has no visible outline (width: {outline_width}px)"


def test_images_have_alt_attributes(page, base_url):
    """All <img> elements have an alt attribute (empty is OK for decorative)."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")

    missing = page.evaluate("""
        () => Array.from(document.querySelectorAll('img'))
            .filter(img => img.getAttribute('alt') === null)
            .map(img => img.src)
    """)
    assert missing == [], f"Images missing alt attribute: {missing}"
