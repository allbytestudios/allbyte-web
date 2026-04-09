"""Test the subscribe/pricing page."""


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
