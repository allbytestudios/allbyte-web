"""Quick visual check that the Discord button lands in the header correctly."""


def test_discord_button_in_header(page, base_url):
    page.goto(f"{base_url}/")
    page.wait_for_load_state("networkidle")

    btn = page.locator("a.discord-server-btn")
    assert btn.count() == 1, f"expected 1 discord button, got {btn.count()}"
    assert btn.get_attribute("href") == "https://discord.gg/qjRmcFaB7Z"

    text = btn.inner_text()
    assert "Discord" in text and "Server" in text, f"unexpected button text: {text!r}"

    # Zoomed-in screenshot of just the button for visual sanity check
    page.evaluate("document.querySelector('a.discord-server-btn').scrollIntoView()")
    btn.screenshot(path="tests/e2e/test_results/discord-server-btn-closeup.png")
    page.locator("header.site-header").screenshot(
        path="tests/e2e/test_results/header-with-discord.png"
    )

    # Bounding box sanity — should match other header buttons
    subscribe_box = page.locator("a.subscribe-btn").bounding_box()
    discord_box = btn.bounding_box()
    print(f"\nsubscribe box: {subscribe_box}")
    print(f"discord box: {discord_box}")

    # Computed styles check — is the button background purple (bug) or dark?
    bg = page.evaluate(
        "getComputedStyle(document.querySelector('a.discord-server-btn')).backgroundColor"
    )
    print(f"discord-server-btn background-color: {bg}")
    # Should be #141b24 = rgb(20, 27, 36)
    assert "20, 27, 36" in bg or "rgb(20, 27, 36)" == bg or bg == "rgba(0, 0, 0, 0)", (
        f"discord btn has unexpected bg {bg}"
    )
