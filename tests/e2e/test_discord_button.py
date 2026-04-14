"""Quick visual check that the Discord button lands in the notify bar correctly."""


def test_discord_button_in_notify_bar(page, base_url):
    page.goto(f"{base_url}/")
    page.wait_for_load_state("networkidle")

    btn = page.locator("a.discord-notify-btn")
    assert btn.count() == 1, f"expected 1 discord button, got {btn.count()}"
    assert btn.get_attribute("href") == "https://discord.gg/qjRmcFaB7Z"
    assert btn.get_attribute("target") == "_blank"

    text = btn.inner_text()
    assert "Discord Server" in text, f"unexpected button text: {text!r}"

    # Must be inside the notify bar, not the header
    in_notify = page.locator(".notify-bar a.discord-notify-btn").count()
    assert in_notify == 1, "discord button not inside .notify-bar"
    in_header = page.locator("header.site-header a.discord-notify-btn").count()
    assert in_header == 0, "discord button should not be in header anymore"

    # Screenshot for visual sanity
    page.locator(".notify-bar").screenshot(
        path="tests/e2e/test_results/notify-bar-with-discord.png"
    )
