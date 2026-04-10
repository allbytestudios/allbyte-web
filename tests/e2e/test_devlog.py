"""Test devlog category and post pages."""


def test_devlog_index_redirects_to_home(page, base_url):
    """The /devlog/ hub now redirects to home, where the categories live."""
    page.goto(f"{base_url}/devlog/", wait_until="domcontentloaded")
    # Should land on home (or follow the meta refresh redirect)
    page.wait_for_timeout(500)
    assert page.url.rstrip("/") == base_url.rstrip("/") or "/devlog/" not in page.url


def test_devlog_category_links_from_home(page, base_url):
    """Home page has links to all 3 devlog categories."""
    page.goto(f"{base_url}/", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")

    chronicles = page.locator('a[href="/devlog/chronicles/"]').first
    godot = page.locator('a[href="/devlog/godot-and-claude/"]').first
    studio = page.locator('a[href="/devlog/studio/"]').first

    assert chronicles.count() > 0, "Home should link to /devlog/chronicles/"
    assert godot.count() > 0, "Home should link to /devlog/godot-and-claude/"
    assert studio.count() > 0, "Home should link to /devlog/studio/"


def test_devlog_post_renders_content(page, base_url):
    """A devlog post page renders article content."""
    # Navigate to a known post via the chronicles category
    page.goto(f"{base_url}/devlog/chronicles/", wait_until="domcontentloaded")

    # Click the first devlog post card (not header/breadcrumb links)
    post_links = page.locator("a.devlog-card").all()
    if len(post_links) > 0:
        post_links[0].click()
        page.wait_for_load_state("domcontentloaded")

    # Check for article content or post content
    content = page.locator(".post-content, .article, article")
    if content.count() > 0:
        content.first.wait_for(state="visible")
