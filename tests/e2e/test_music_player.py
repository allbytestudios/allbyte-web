"""Test the music page and persistent music player."""


def test_track_list_populated(page, base_url):
    """Music page shows track cards."""
    page.goto(f"{base_url}/music/", wait_until="domcontentloaded")
    tracks = page.locator(".track-card")
    tracks.first.wait_for(state="visible")
    assert tracks.count() >= 1, "Expected at least one track card"


def test_track_card_has_name(page, base_url):
    """Each track card displays a track name."""
    page.goto(f"{base_url}/music/", wait_until="domcontentloaded")
    first_name = page.locator(".track-name").first
    first_name.wait_for(state="visible")
    assert first_name.inner_text().strip(), "Track name should not be empty"
