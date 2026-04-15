"""TestNav Questions badge reads from owner_questions.json, not agent_chat."""


def test_questions_pending_badge(page, base_url):
    page.goto(f"{base_url}/test/")
    page.wait_for_load_state("networkidle")

    tab = page.locator("a.nav-tab:has-text('Questions')")
    tab.wait_for(state="visible", timeout=5000)

    yellow = tab.locator(".nav-yellow").inner_text().strip()
    grey = tab.locator(".nav-grey").inner_text().strip()
    print(f"\n[badge] yellow: {yellow!r}, grey: {grey!r}")
    # Arc's sample has 8 pending questions (all status=pending). If he backfills,
    # expect a larger number — either way it should be > 0.
    assert int(yellow) > 0, f"expected pending count > 0, got {yellow}"
    assert int(grey) >= int(yellow), f"total {grey} should be >= pending {yellow}"
