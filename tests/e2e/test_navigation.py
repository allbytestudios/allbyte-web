"""Test that all pages load and navigation works."""
import pytest


PAGES = [
    ("/", "index"),
    ("/play/", "play"),
    ("/music/", "music"),
    ("/artwork/", "artwork"),
    ("/fonts/", "fonts"),
    ("/subscribe/", "subscribe"),
    ("/self-hosting-with-claude/", "self-hosting"),
    ("/devlog/chronicles/", "devlog chronicles"),
    ("/devlog/godot-and-claude/", "devlog godot-and-claude"),
    ("/devlog/studio/", "devlog studio"),
]


@pytest.mark.parametrize("path,name", PAGES, ids=[p[1] for p in PAGES])
def test_page_loads(page, base_url, path, name):
    """Each page returns 200 and has visible content."""
    resp = page.goto(f"{base_url}{path}", wait_until="domcontentloaded")
    assert resp.status == 200, f"{name} page returned {resp.status}"
    # Every page should have some visible content
    page.wait_for_selector("body", state="visible")


def test_trailing_slash_redirect(page, base_url):
    """Pages without trailing slash should redirect to trailing slash version."""
    resp = page.goto(f"{base_url}/music", wait_until="domcontentloaded")
    assert "/music/" in page.url, f"Expected trailing slash redirect, got {page.url}"
