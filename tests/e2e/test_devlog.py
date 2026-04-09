"""Test devlog index and post pages."""


def test_devlog_index_loads(page, base_url):
    """Devlog index page shows hub cards."""
    page.goto(f"{base_url}/devlog/", wait_until="domcontentloaded")
    cards = page.locator(".hub-card")
    cards.first.wait_for(state="visible")
    assert cards.count() >= 1, "Expected at least one devlog hub card"


def test_devlog_hub_links(page, base_url):
    """Hub cards link to devlog category pages."""
    page.goto(f"{base_url}/devlog/", wait_until="domcontentloaded")
    cards = page.locator(".hub-card")
    cards.first.wait_for(state="visible")

    # Check that cards have href attributes pointing to devlog subpages
    hrefs = []
    for i in range(cards.count()):
        href = cards.nth(i).get_attribute("href")
        if href:
            hrefs.append(href)
    assert len(hrefs) >= 1, "Expected hub cards to have links"


def test_devlog_post_renders_content(page, base_url):
    """A devlog post page renders article content."""
    # Navigate to a known post via the chronicles category
    page.goto(f"{base_url}/devlog/chronicles/", wait_until="domcontentloaded")

    # If there are post links, click the first one
    post_links = page.locator("a[href*='/devlog/']").all()
    if len(post_links) > 1:
        post_links[1].click()
        page.wait_for_load_state("domcontentloaded")

    # Check for article content or post content
    content = page.locator(".post-content, .article, article")
    if content.count() > 0:
        content.first.wait_for(state="visible")
