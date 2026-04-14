"""Test the subscribe/pricing page.

Render checks run unmocked (page is static). The checkout-flow tests mock
/checkout and stub checkout.stripe.com so CI doesn't hit real Stripe. They
catch UI regressions: wrong prices, broken buttons, wrong tier name sent to
the backend, bad success banner.

Full end-to-end tests against Stripe's hosted Checkout page itself aren't run
here — Stripe's page isn't in our control and shouldn't gate pre-deploy CI.
Run those manually in test-mode before flipping to live keys (see the Stripe
readiness checklist).
"""
import json
import pytest


EXPECTED_TIERS = [
    # (data-tier value sent to backend, visible price label)
    ("initiate", "$3"),
    ("hero", "$7"),
    ("legend", "$15"),
]

EXPECTED_DONATIONS = [
    ("donate_5", "$5"),
    ("donate_10", "$10"),
    ("donate_25", "$25"),
]


def _stub_stripe_redirect(page):
    """The mocked /checkout returns checkout.stripe.com/mock-session; stub
    that URL so post-click navigation resolves instead of 404ing."""
    page.route(
        "https://checkout.stripe.com/**",
        lambda r: r.fulfill(
            status=200,
            content_type="text/html",
            body="<html><body>Stub Stripe Checkout</body></html>",
        ),
    )


def test_tier_cards_render(page, base_url):
    """Three subscription tier cards are visible."""
    page.goto(f"{base_url}/subscribe/", wait_until="domcontentloaded")
    cards = page.locator(".tier-card")
    cards.first.wait_for(state="visible")
    assert cards.count() == 3, f"Expected 3 tier cards, got {cards.count()}"


def test_tier_names_and_prices(page, base_url):
    """Tier cards show correct names and prices."""
    page.goto(f"{base_url}/subscribe/", wait_until="domcontentloaded")
    page.locator(".tier-card").first.wait_for(state="visible")

    names = page.locator(".tier-name").all_inner_texts()
    assert "Initiate" in names
    assert "Hero" in names
    assert "Legend" in names

    prices = page.locator(".price-amount").all_inner_texts()
    # Prices should contain $3, $7, $15
    price_text = " ".join(prices)
    assert "3" in price_text
    assert "7" in price_text
    assert "15" in price_text


def test_subscribe_buttons_present(page, base_url):
    """Each tier has a subscribe/action button."""
    page.goto(f"{base_url}/subscribe/", wait_until="domcontentloaded")
    page.locator(".tier-card").first.wait_for(state="visible")
    buttons = page.locator(".tier-btn")
    assert buttons.count() >= 3, f"Expected at least 3 tier buttons, got {buttons.count()}"


def test_donation_buttons_present(page, base_url):
    """All three donation buttons render with correct labels."""
    page.goto(f"{base_url}/subscribe/", wait_until="domcontentloaded")
    page.locator(".tier-card").first.wait_for(state="visible")
    for data_tier, label in EXPECTED_DONATIONS:
        btn = page.locator(f"button.donate-btn[data-tier='{data_tier}']")
        assert btn.count() == 1, f"missing donate button {data_tier}"
        assert label in btn.inner_text(), (
            f"donate button {data_tier} should show {label}, got {btn.inner_text()!r}"
        )


# --- Checkout flow tests (mocked) ---

@pytest.mark.parametrize("tier,_price", EXPECTED_TIERS)
def test_subscribe_tier_posts_correct_payload(page, mock_api, base_url, tier, _price):
    """Clicking a tier POSTs {tier: <name>} to /checkout and navigates to the returned URL."""
    _stub_stripe_redirect(page)

    captured = {}

    def capture_checkout(route):
        req = route.request
        captured["method"] = req.method
        try:
            captured["body"] = req.post_data_json
        except Exception:
            captured["body"] = req.post_data
        captured["auth"] = req.headers.get("authorization")
        route.fulfill(
            status=200,
            content_type="application/json",
            body='{"url":"https://checkout.stripe.com/mock-session"}',
        )

    page.route(
        "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com/checkout",
        capture_checkout,
    )

    page.goto(f"{base_url}/subscribe/")
    page.wait_for_load_state("networkidle")

    with page.expect_navigation(url="https://checkout.stripe.com/**"):
        page.locator(f"button.tier-btn[data-tier='{tier}']").click()

    assert captured.get("method") == "POST", f"expected POST, got {captured.get('method')}"
    body = captured.get("body") or {}
    if isinstance(body, str):
        body = json.loads(body)
    assert body.get("tier") == tier, f"expected tier={tier!r} in body, got {body!r}"


@pytest.mark.parametrize("data_tier,_label", EXPECTED_DONATIONS)
def test_donate_posts_correct_payload(page, mock_api, base_url, data_tier, _label):
    """Donations POST the correct donate_N tier."""
    _stub_stripe_redirect(page)

    captured = {}

    def capture_checkout(route):
        req = route.request
        try:
            captured["body"] = req.post_data_json
        except Exception:
            captured["body"] = req.post_data
        route.fulfill(
            status=200,
            content_type="application/json",
            body='{"url":"https://checkout.stripe.com/mock-session"}',
        )

    page.route(
        "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com/checkout",
        capture_checkout,
    )

    page.goto(f"{base_url}/subscribe/")
    page.wait_for_load_state("networkidle")

    with page.expect_navigation(url="https://checkout.stripe.com/**"):
        page.locator(f"button.donate-btn[data-tier='{data_tier}']").click()

    body = captured.get("body") or {}
    if isinstance(body, str):
        body = json.loads(body)
    assert body.get("tier") == data_tier, (
        f"expected tier={data_tier!r} in body, got {body!r}"
    )


def test_subscribe_shows_success_banner_on_return(page, mock_api, base_url):
    """After Stripe redirects back with ?success=true, the thank-you banner renders."""
    page.goto(f"{base_url}/subscribe/?success=true")
    page.wait_for_load_state("networkidle")

    banner = page.locator(".success-banner")
    assert banner.count() == 1, "success banner missing after ?success=true return"
    assert "Thank you" in banner.inner_text()


def test_subscribe_checkout_failure_button_recovers(page, mock_api, base_url):
    """If /checkout fails, the button recovers to 'Subscribe' instead of staying 'Loading...'."""
    page.route(
        "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com/checkout",
        lambda r: r.fulfill(
            status=500,
            content_type="application/json",
            body='{"error":"boom"}',
        ),
    )
    # Swallow the alert() dialog so it doesn't block the test
    page.on("dialog", lambda d: d.accept())

    page.goto(f"{base_url}/subscribe/")
    page.wait_for_load_state("networkidle")

    btn = page.locator("button.tier-btn[data-tier='hero']")
    btn.click()

    # Button should recover to "Subscribe" after the failure (finally block)
    page.wait_for_function(
        "document.querySelector(\"button.tier-btn[data-tier='hero']\").textContent.trim() === 'Subscribe'",
        timeout=5000,
    )
    assert btn.is_enabled(), "button should be re-enabled after checkout failure"
